import XCTest
@testable import Optio

/// Two paired servers that reach the same Optio (a LAN address and a Tailscale name)
/// each report every session; the Watch lists each once, the first server's copy.
final class WatchMergeTests: XCTestCase {
    private let now = Date(timeIntervalSinceReferenceDate: 811_400_000)

    private func item(_ id: String, _ state: String = "needs_you", server: String) -> WatchItem {
        WatchItem(kind: .local, id: id, title: id, mono: id, since: now, state: state, link: "optio://local/\(id)", serverId: server, serverName: server)
    }

    private func snapshot(needsYou: [WatchItem] = [], running: [WatchItem] = []) -> NeedsYouSnapshot {
        NeedsYouSnapshot(needsYou: needsYou, running: running, hostsOnline: 1, hostsTotal: 1, asOf: now)
    }

    func testTheSameSessionFromTwoServersIsListedOnce() {
        var merged = snapshot(needsYou: [item("a", server: "home")], running: [item("b", "working", server: "home")])
        merged.merge(snapshot(needsYou: [item("a", server: "tailscale")], running: [item("b", "working", server: "tailscale"), item("c", "working", server: "tailscale")]))
        XCTAssertEqual(merged.needsYou.map(\.id), ["a"])
        XCTAssertEqual(merged.running.map(\.id), ["b", "c"])
        XCTAssertEqual(merged.needsYou.first?.serverId, "home", "the first server's copy is kept")
        XCTAssertEqual(merged.hostsTotal, 2, "hosts still sum: each entry is a server as far as the counts go")
    }

    func testASessionNeedingYouIsNotAlsoRunning() {
        var merged = snapshot(needsYou: [item("a", server: "home")])
        merged.merge(snapshot(running: [item("a", "working", server: "tailscale")]))
        XCTAssertEqual(merged.needsYou.map(\.id), ["a"])
        XCTAssertTrue(merged.running.isEmpty)
    }

    func testDistinctSessionsAllMerge() {
        var merged = snapshot(needsYou: [item("a", server: "home")])
        merged.merge(snapshot(needsYou: [item("b", server: "work")], running: [item("c", "working", server: "work")]))
        XCTAssertEqual(merged.needsYou.map(\.id), ["a", "b"])
        XCTAssertEqual(merged.running.map(\.id), ["c"])
    }
}
