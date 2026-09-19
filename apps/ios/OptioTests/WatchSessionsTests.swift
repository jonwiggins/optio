import XCTest
@testable import Optio

/// The Watch wire contract after the Sessions redesign: the session chips and board
/// tiles are optional and additive (frames from older servers still decode, and the
/// fallbacks give every row four chips), `NeedsYouSnapshot` carries the tiles into
/// the Live Activity state, and the new deep links round-trip.
final class WatchSessionsTests: XCTestCase {
    /// ActivityKit decodes `content-state` with a default `JSONDecoder` (dates = Apple seconds).
    private let decoder = JSONDecoder()

    private func decode<T: Decodable>(_ json: String, as: T.Type = T.self) throws -> T {
        try decoder.decode(T.self, from: Data(json.utf8))
    }

    // MARK: Wire

    func testFrameWithSessionFieldsDecodes() throws {
        let json = """
        {"phase":"waiting","head":{"kind":"local","id":"t1","title":"claude-code · web","mono":"web",
          "reason":"Waiting on a permission","since":811397599,"state":"needs_you","link":"optio://local/t1?compose=1",
          "source":"local-terminal","when":"now","where":{"target":"machine","detail":"mbp · ~/optio/apps/web"},
          "who":"claude-code","then":"waits-for-me","statusLabel":"needs you"},
         "others":[],"needsYouCount":1,"runningCount":2,"waitingCount":1,"recurringCount":4,"agentCount":2,"asOf":811397839}
        """
        let state: WatchState = try decode(json)
        XCTAssertEqual(state.phase, .waiting)
        XCTAssertEqual(state.waitingCount, 1)
        XCTAssertEqual(state.recurringCount, 4)
        XCTAssertEqual(state.agentCount, 2)
        let head = try XCTUnwrap(state.head)
        XCTAssertEqual(head.source, .localTerminal)
        XCTAssertEqual(head.whenLabel, "now")
        XCTAssertEqual(head.whereValue, WatchWhere(target: .machine, detail: "mbp · ~/optio/apps/web"))
        XCTAssertEqual(head.whoValue, "claude-code")
        XCTAssertFalse(head.whoIsTerminal)
        XCTAssertEqual(head.thenValue, .waitsForMe)
        XCTAssertEqual(head.statusText, "needs you")
        XCTAssertEqual(head.since, Date(timeIntervalSinceReferenceDate: 811_397_599))
    }

    func testLegacyFrameDecodesWithFallbacks() throws {
        // A frame from a server that predates the session fields: the sample payload shape.
        let json = """
        {"phase":"waiting","head":{"kind":"local","id":"t1","title":"claude-code · optio","mono":"repos/optio/apps/web",
          "reason":"Waiting on a permission","preview":"Allow?","since":811397599,"state":"needs_you",
          "link":"optio://local/t1?compose=1","prUrl":null,"snoozedUntil":null},
         "others":[{"kind":"task","id":"k","title":"docs","mono":"docs/readme","reason":"PR #581 open · CI running",
          "since":811397119,"state":"pr_opened","link":"optio://tasks/k","prUrl":"https://x/pull/581"}],
         "needsYouCount":2,"runningCount":3,"offlineSince":null,"summary":null,"asOf":811397839}
        """
        let state: WatchState = try decode(json)
        XCTAssertNil(state.waitingCount)
        XCTAssertNil(state.recurringCount)
        XCTAssertNil(state.agentCount)

        let local = try XCTUnwrap(state.head)
        XCTAssertNil(local.source)
        XCTAssertEqual(local.whenLabel, "now")
        XCTAssertEqual(local.whereValue, WatchWhere(target: .machine, detail: "repos/optio/apps/web"))
        XCTAssertEqual(local.whoValue, "claude-code", "agent named in the default terminal title")
        XCTAssertEqual(local.thenValue, .waitsForMe)
        XCTAssertEqual(local.statusText, "needs you")

        let task = state.others[0]
        XCTAssertEqual(task.whereValue, WatchWhere(target: .pod, detail: "docs/readme"))
        XCTAssertEqual(task.whoValue, "claude-code")
        XCTAssertEqual(task.thenValue, .exits)
        XCTAssertEqual(task.statusText, "PR open")

        let agent = WatchItem(kind: .agent, id: "a", title: "Vesper", mono: "@vesper", since: .now, state: "running", link: "optio://agents/a")
        XCTAssertEqual(agent.whenLabel, "messages")
        XCTAssertEqual(agent.thenValue, .waitsForMessages)
        XCTAssertEqual(agent.whenSystemImage, "cpu")

        let shell = WatchItem(kind: .local, id: "s", title: "zsh", mono: "notes", since: .now, state: "needs_you", link: "optio://local/s")
        XCTAssertEqual(shell.whoValue, "terminal")
        XCTAssertTrue(shell.whoIsTerminal)
        XCTAssertEqual(shell.whoSystemImage, "terminal")
    }

    func testEncodingRoundTripsSessionFields() throws {
        let item = WatchItem(kind: .task, id: "t", title: "Fix", mono: "fix/x", since: Date(timeIntervalSinceReferenceDate: 1), state: "running", link: "optio://tasks/t",
                             source: .repoTask, when: "on a trigger", where: WatchWhere(target: .pod, detail: "acme/web"), who: "codex", then: .exits, statusLabel: "running")
        let data = try JSONEncoder().encode(item)
        let back = try decoder.decode(WatchItem.self, from: data)
        XCTAssertEqual(back, item)
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(keys["where"] as? [String: String], ["target": "pod", "detail": "acme/web"])
        XCTAssertEqual(keys["then"] as? String, "exits")
        XCTAssertEqual(keys["source"] as? String, "repo-task")
    }

    // MARK: Snapshot → Watch state

    func testSnapshotCarriesTilesIntoWatchState() {
        let now = Date()
        let need = WatchItem(kind: .local, id: "a", title: "a", mono: "a", since: now.addingTimeInterval(-60), state: "needs_you", link: "optio://local/a")
        let run = WatchItem(kind: .local, id: "b", title: "b", mono: "b", since: now, state: "working", link: "optio://local/b")
        let counts = SessionTileCounts(waiting: 2, recurring: 3, agents: 4)
        let waiting = NeedsYouSnapshot(needsYou: [need], running: [run], hostsOnline: 1, hostsTotal: 1, counts: counts, asOf: now).watchState()
        XCTAssertEqual(waiting.phase, .waiting)
        XCTAssertEqual(waiting.waitingCount, 2)
        XCTAssertEqual(waiting.recurringCount, 3)
        XCTAssertEqual(waiting.agentCount, 4)

        let working = NeedsYouSnapshot(needsYou: [], running: [run], hostsOnline: 1, hostsTotal: 1, counts: counts, asOf: now).watchState()
        XCTAssertEqual(working.phase, .working)
        XCTAssertEqual(working.recurringCount, 3)

        let legacy = NeedsYouSnapshot(needsYou: [], running: [run], hostsOnline: 1, hostsTotal: 1, asOf: now).watchState()
        XCTAssertNil(legacy.recurringCount)
    }

    func testMergeSumsTilesAcrossServers() {
        var a = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 1, hostsTotal: 1, counts: SessionTileCounts(waiting: 1, recurring: 2, agents: 3))
        let b = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 0, hostsTotal: 1, counts: SessionTileCounts(waiting: 10, recurring: 20, agents: 30))
        let legacy = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 1, hostsTotal: 1)
        a.merge(b)
        XCTAssertEqual(a.counts, SessionTileCounts(waiting: 11, recurring: 22, agents: 33))
        XCTAssertEqual(a.hostsTotal, 2)
        a.merge(legacy)
        XCTAssertEqual(a.counts, SessionTileCounts(waiting: 11, recurring: 22, agents: 33), "a server without tiles adds nothing")
        var none = legacy
        none.merge(legacy)
        XCTAssertNil(none.counts)
    }

    func testCachedSnapshotWithoutTilesStillDecodes() throws {
        // Older App Group caches have no `counts` key.
        let json = """
        {"needsYou":[],"running":[],"hostsOnline":1,"hostsTotal":1,"asOf":"2026-09-17T12:00:00Z"}
        """
        let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601
        let snap = try d.decode(NeedsYouSnapshot.self, from: Data(json.utf8))
        XCTAssertNil(snap.counts)
    }

    func testShortDirAndRepo() {
        XCTAssertEqual(NeedsYouSnapshot.shortDir("/Users/jon/repos/optio/apps/web"), "~/repos/optio/apps/web")
        XCTAssertEqual(NeedsYouSnapshot.shortDir("/home/dev/x"), "~/x")
        XCTAssertEqual(NeedsYouSnapshot.shortDir("/Users/jon"), "~")
        XCTAssertEqual(NeedsYouSnapshot.shortDir("/srv/app"), "/srv/app")
        XCTAssertEqual(NeedsYouSnapshot.shortRepo("https://github.com/acme/web.git"), "acme/web")
        XCTAssertEqual(NeedsYouSnapshot.shortRepo("https://gitlab.example.com/g/sub/repo"), "g/sub/repo")
        XCTAssertNil(NeedsYouSnapshot.shortRepo(nil))
        XCTAssertEqual(NeedsYouSnapshot.terminalStatusLabel(state: "running", attentionState: "idle"), "idle")
        XCTAssertEqual(NeedsYouSnapshot.terminalStatusLabel(state: "exited", attentionState: "needs_you"), "exited")
        XCTAssertEqual(NeedsYouSnapshot.taskStatusLabel("needs_attention"), "needs attention")
        XCTAssertEqual(NeedsYouSnapshot.taskStatusLabel("pr_opened"), "PR open")
    }

    // MARK: Deep links

    func testNewSessionAndSessionsViewLinks() throws {
        XCTAssertEqual(DeepLink.newSession.url.absoluteString, "optio://sessions/new")
        XCTAssertEqual(DeepLink(url: try XCTUnwrap(URL(string: "optio://sessions/new"))), .newSession)
        XCTAssertEqual(DeepLink(url: try XCTUnwrap(URL(string: "optio://sessions/abc"))), .session("abc"), "ids other than `new` still open a pod session")

        let active = DeepLink.sessions(view: "active").url
        XCTAssertEqual(active.absoluteString, "optio://section/sessions?view=active")
        XCTAssertEqual(DeepLink(url: active), .sessions(view: "active"))
        XCTAssertEqual(DeepLink(url: try XCTUnwrap(URL(string: "optio://section/sessions"))), .section("sessions"))
        XCTAssertEqual(DeepLink.serverId(in: DeepLink.sessions(view: "agents").url(server: "s1")), "s1")
    }

    @MainActor
    func testRouterOpensNewSessionSheetAndViews() throws {
        let router = AppRouter()
        XCTAssertTrue(router.handle(url: try XCTUnwrap(URL(string: "optio://sessions/new"))))
        XCTAssertTrue(router.pendingNewSession)
        XCTAssertEqual(router.pendingSection, .sessions)
        XCTAssertEqual(router.selectedTab, .work)

        XCTAssertTrue(router.handle(url: try XCTUnwrap(URL(string: "optio://section/sessions?view=recurring"))))
        XCTAssertEqual(router.pendingSessionView, .recurring)
        XCTAssertTrue(router.handle(url: try XCTUnwrap(URL(string: "optio://section/sessions?view=bogus"))))
        XCTAssertEqual(router.pendingSessionView, .active, "unknown views fall back to Active")
    }
}
