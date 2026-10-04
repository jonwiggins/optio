import XCTest
@testable import Optio

/// Mirrors `apps/web/src/lib/work-places.test.ts`.
final class WorkPlacesTests: XCTestCase {
    private func row(_ key: String, _ source: WorkSource, _ status: WorkStatus,
                     _ where: SessionWhere, recurring: Bool = false) -> WorkRow {
        WorkRow(key: key, source: source, sourceId: key, href: "/x/\(key)", name: key, when: "now",
                where: `where`, who: "claude-code", then: .exits, status: status, statusLabel: "",
                note: nil, prUrl: nil, lastActivity: "2026-09-24T10:00:00Z",
                recurring: recurring, spawned: false)
    }

    private func machine(_ hostId: String?) -> SessionWhere {
        SessionWhere(target: .machine, detail: "M · ~/app", hostId: hostId, dir: "/Users/dev/app")
    }

    private func pod(_ detail: String?) -> SessionWhere { SessionWhere(target: .pod, detail: detail) }

    private var places: WorkPlaces {
        WorkPlaces(rows: [
            row("terminal", .localTerminal, .needsYou, machine("h1")),
            row("local-task", .repoTask, .running, machine("h1")),
            row("automation", .localBlueprint, .scheduled, machine("h1"), recurring: true),
            row("old-terminal", .localTerminal, .done, machine("h1")),
            row("teammate", .repoTask, .running, machine("h-other")),
            row("task-a", .repoTask, .running, pod("acme/a")),
            row("blueprint-a", .repoBlueprint, .scheduled, pod("acme/a"), recurring: true),
            row("session-b", .podSession, .waiting, pod("acme/b")),
            row("task-b", .repoTask, .waiting, pod("acme/b")),
            row("job", .standalone, .scheduled, pod(nil), recurring: true),
            row("agent-idle", .persistentAgent, .waiting, pod("@forge")),
            row("agent-paused", .persistentAgent, .paused, pod("@old")),
            row("agent-archived", .persistentAgent, .done, pod("@gone")),
        ], hostIds: ["h1", "h2"])
    }

    func testEachMachineHoldsItsLiveAndRecurringWork() {
        let p = places
        XCTAssertEqual(p.machines["h1"]?.now.map(\.key), ["terminal", "local-task"])
        XCTAssertEqual(p.machines["h1"]?.setUp.map(\.key), ["automation"])
        XCTAssertEqual(p.machines["h2"], PlaceWork())
        XCTAssertEqual(p.otherMachines.now.map(\.key), ["teammate"])
        XCTAssertEqual(p.machines["h1"]?.nowSummary, "1 needs you · 1 active")
    }

    func testPodWorkGroupsByRepoThenJobsThenAgents() {
        let p = places
        XCTAssertEqual(p.pods.map(\.label), ["acme/b", "acme/a", "Jobs", "Persistent agents"])
        XCTAssertEqual(p.pods[1].work.setUp.map(\.key), ["blueprint-a"])
        XCTAssertEqual(p.pods[2].work.setUp.map(\.key), ["job"])
        XCTAssertEqual(p.pods[3].work.now.map(\.key), ["agent-idle"])
        XCTAssertEqual(p.pods[3].work.setUp.map(\.key), ["agent-paused"])
    }
}
