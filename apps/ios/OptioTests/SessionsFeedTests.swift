import XCTest
@testable import Optio

/// Mirrors `apps/web/src/lib/sessions-feed.test.ts`: the Swift port must project
/// every source onto the same rows, in the same order, with the same counts.
final class SessionsFeedTests: XCTestCase {
    private typealias F = SessionsFeed

    private func sources() -> F.Sources {
        F.Sources(
            unified: [
                F.UnifiedRow(type: "repo-task", id: "t1", title: "Fix bug", state: "completed",
                             repoUrl: "https://github.com/acme/app", agentType: "codex",
                             prUrl: "https://github.com/acme/app/pull/7", updatedAt: "2026-09-01T00:00:00Z"),
                F.UnifiedRow(type: "repo-task", id: "t2", title: "Needs me", state: "needs_attention",
                             runTarget: "local", localHostId: "h1", localDir: "/Users/dev/app",
                             updatedAt: "2026-08-01T00:00:00Z"),
                F.UnifiedRow(type: "repo-blueprint", id: "b1", name: "Nightly", enabled: true, repoUrl: "x"),
                F.UnifiedRow(type: "standalone", id: "j1", name: "Report", enabled: false, agentRuntime: "gemini"),
            ],
            localTerminals: [
                F.TerminalRow(id: "lt1", title: "shell", state: "running", attentionState: "needs_you",
                              hostId: "h1", dir: "/Users/dev/notes", spec: .init(kind: "shell"),
                              spawnedBy: "manual", lastActivityAt: "2026-09-02T00:00:00Z"),
                F.TerminalRow(id: "lt2", title: "dup", state: "running",
                              spec: .init(kind: "agent", agent: "claude-code"), taskId: "t2"),
            ],
            localBlueprints: [
                F.BlueprintRow(id: "a1", name: "Review PRs", agent: "claude-code", hostId: "h1", enabled: true),
            ],
            podSessions: [
                F.PodSessionRow(id: "s1", repoUrl: "https://github.com/acme/app", branch: "session/x", state: "active"),
            ],
            agents: [
                F.AgentRow(id: "pa1", slug: "forge", name: "Forge", state: "idle", agentRuntime: "claude-code"),
            ],
            hosts: [F.HostRow(id: "h1", name: "M1")]
        )
    }

    func testProjectsEverySourceOntoTheSameRowShapeAndRanksNeedsYouFirst() {
        let rows = F.collect(sources())
        func row(_ key: String) -> SessionRow? { rows.first { $0.key == key } }

        XCTAssertFalse(rows.contains { $0.key == "terminal-lt2" }, "a local Task run is already its tasks row")
        XCTAssertEqual(rows.prefix(2).map(\.status), [.needsYou, .needsYou])
        XCTAssertEqual(rows.first?.key, "terminal-lt1", "most recent needs-you first")

        XCTAssertEqual(row("task-t2")?.where, SessionWhere(target: .machine, detail: "M1 · ~/app"))
        XCTAssertEqual(row("task-t1")?.note, "PR 7")
        XCTAssertEqual(row("task-t1")?.href, "/tasks/t1")
        XCTAssertEqual(row("job-j1")?.status, .paused)
        XCTAssertEqual(row("agent-pa1")?.then, .waitsForMessages)
        XCTAssertEqual(row("session-s1")?.who, "terminal")
        XCTAssertEqual(row("blueprint-b1")?.statusLabel, "armed")
        XCTAssertEqual(row("automation-a1")?.then, .waitsForMe)

        XCTAssertEqual(F.count(rows), SessionCounts(needsYou: 2, running: 0, waiting: 1, recurring: 2, agents: 1))

        XCTAssertEqual(rows.filter { F.inView($0, .active) }.map(\.key).sorted(),
                       ["session-s1", "task-t2", "terminal-lt1", "agent-pa1"].sorted())
        XCTAssertEqual(rows.filter { F.inView($0, .recurring) }.map(\.key).sorted(),
                       ["automation-a1", "blueprint-b1", "job-j1"].sorted())
        XCTAssertEqual(rows.filter { F.inView($0, .history) }.map(\.key), ["task-t1"])
        XCTAssertEqual(rows.filter { F.inView($0, .agents) }.map(\.key), ["agent-pa1"])
        XCTAssertEqual(rows.filter { F.inView($0, .all) }.count, rows.count)
    }

    func testRowsLeadToTheirKindsDetailScreen() {
        let rows = F.collect(sources())
        func dest(_ key: String) -> SessionDestination? { rows.first { $0.key == key }?.destination }
        XCTAssertEqual(dest("task-t1"), .task("t1"))
        XCTAssertEqual(dest("blueprint-b1"), .blueprint("b1"))
        XCTAssertEqual(dest("job-j1"), .job("j1"))
        XCTAssertEqual(dest("terminal-lt1"), .localTerminal("lt1"))
        XCTAssertEqual(dest("automation-a1"), .localBlueprint("a1"))
        XCTAssertEqual(dest("session-s1"), .podSession("s1"))
        XCTAssertEqual(dest("agent-pa1"), .agent("pa1"))
    }

    func testStatusMaps() {
        XCTAssertEqual(F.taskStatus("pr_opened").0, .waiting)
        XCTAssertEqual(F.taskStatus("waiting_on_deps").1, "waiting on deps")
        XCTAssertEqual(F.taskStatus("cancelled").0, .done)
        XCTAssertEqual(F.terminalStatus(.init(state: "pending", pendingReason: "host_offline")).1, "host offline")
        XCTAssertEqual(F.terminalStatus(.init(state: "running", attentionState: "idle")).0, .waiting)
        XCTAssertEqual(F.terminalStatus(.init(state: "exited")).0, .done)
        XCTAssertEqual(F.agentStatus(.init(state: "archived")).0, .done)
        XCTAssertEqual(F.agentStatus(.init(state: nil)).1, "idle")
    }

    func testHeadlessAgentTerminalsExitAndSpawnedRunsAreMarked() {
        let rows = F.collect(F.Sources(localTerminals: [
            F.TerminalRow(id: "h", title: "headless", state: "running", attentionState: "working",
                          spec: .init(kind: "agent", agent: "codex", mode: "headless"), spawnedBy: "job", workflowRunId: "r1"),
        ]))
        XCTAssertEqual(rows.first?.then, .exits)
        XCTAssertEqual(rows.first?.who, "codex")
        XCTAssertEqual(rows.first?.when, "job")
        XCTAssertEqual(rows.first?.spawned, true)
        XCTAssertEqual(rows.first?.status, .running)
    }

    func testSearchMatchesNamePlaceAgentStatusAndNote() {
        let rows = F.collect(sources())
        XCTAssertEqual(rows.filter { F.matches($0, query: "acme") }.map(\.key).sorted(), ["session-s1", "task-t1"])
        XCTAssertEqual(rows.filter { F.matches($0, query: "GEMINI") }.map(\.key), ["job-j1"])
        XCTAssertEqual(rows.filter { F.matches($0, query: "PR 7") }.map(\.key), ["task-t1"])
        XCTAssertEqual(rows.filter { F.matches($0, query: "  ") }.count, rows.count)
    }

    func testShortLabels() {
        XCTAssertEqual(F.shortRepo("https://github.com/acme/app.git"), "acme/app")
        XCTAssertEqual(F.shortRepo("https://gitlab.example.com/group/proj"), "group/proj")
        XCTAssertNil(F.shortRepo(nil))
        XCTAssertEqual(F.shortDir("/Users/dev/app"), "~/app")
        XCTAssertEqual(F.shortDir("/home/dev/notes"), "~/notes")
        XCTAssertEqual(F.shortDir("/srv/x"), "/srv/x")
        XCTAssertEqual(F.runtimeLabel("claude-code"), "Claude Code")
        XCTAssertEqual(F.runtimeLabel("mystery"), "mystery")
    }

    func testDecodesLooseRows() throws {
        let json = #"""
        {"tasks":[{"type":"repo-task","id":"t1","title":"x","state":"running","metadata":{"taskConfigId":"c1","extra":1},"priority":5}]}
        """#.data(using: .utf8)!
        struct R: Decodable { var tasks: [SessionsFeed.UnifiedRow] }
        let rows = F.collect(F.Sources(unified: try JSONDecoder().decode(R.self, from: json).tasks))
        XCTAssertEqual(rows.first?.when, "on a trigger")
        XCTAssertEqual(rows.first?.spawned, true)
    }

    @MainActor
    func testLegacySectionNamesLandOnSessionsViews() {
        XCTAssertEqual(AppRouter.section(named: "tasks")?.0, .sessions)
        XCTAssertEqual(AppRouter.section(named: "tasks")?.1, .all)
        XCTAssertEqual(AppRouter.section(named: "jobs")?.1, .recurring)
        XCTAssertEqual(AppRouter.section(named: "agents")?.1, .agents)
        XCTAssertEqual(AppRouter.section(named: "local")?.1, .active)
        XCTAssertEqual(AppRouter.section(named: "issues")?.0, .inbox)
        XCTAssertEqual(AppRouter.section(named: "machines")?.0, .machines)
        XCTAssertNil(AppRouter.section(named: "nope"))

        let router = AppRouter()
        XCTAssertTrue(router.handle(url: URL(string: "optio://section/sessions?view=recurring")!))
        XCTAssertEqual(router.selectedTab, .work)
        XCTAssertEqual(router.pendingSection, .sessions)
        XCTAssertEqual(router.pendingSessionView, .recurring)
        XCTAssertTrue(router.handle(url: URL(string: "optio://tasks/abc")!))
        XCTAssertEqual(router.pendingDetail, .init(kind: .task, id: "abc"))
        XCTAssertTrue(router.handle(url: URL(string: "optio://needs-you")!))
        XCTAssertEqual(router.pendingSessionView, .active)
    }
}
