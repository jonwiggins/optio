import XCTest
@testable import Optio

/// Mirrors `collectProviderLimits` / `windowLabel` / `resetsIn` in
/// `apps/web/src/components/dashboard/limits-panel.tsx`: the pure projection
/// the limits panel and the header pill draw from.
final class ProviderLimitsTests: XCTestCase {
    private let now = "2026-09-19T23:00:00Z".isoDate!

    private func host(_ id: String, codex: LocalHostAgentLimits.Codex?) -> LocalHost {
        LocalHost(
            id: id, name: id, hostname: id, platform: "darwin", dirs: [],
            agentLimits: codex.map { LocalHostAgentLimits(codex: $0) },
            state: .online, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z"
        )
    }

    func testWindowLabel() {
        XCTAssertEqual(UsageLimits.windowLabel(300, fallback: "x"), "5h")
        XCTAssertEqual(UsageLimits.windowLabel(10080, fallback: "x"), "7d")
        XCTAssertEqual(UsageLimits.windowLabel(90, fallback: "x"), "90m")
        XCTAssertEqual(UsageLimits.windowLabel(nil, fallback: "5h"), "5h")
        XCTAssertEqual(UsageLimits.windowLabel(0, fallback: "7d"), "7d")
    }

    func testClaudeLiveWindowsAndPerModelBuckets() {
        let usage = ClaudeUsageData(
            available: true,
            fiveHour: UsageWindow(utilization: 31, resetsAt: "2026-09-19T23:20:00Z"),
            sevenDay: UsageWindow(utilization: 52, resetsAt: "2026-09-20T21:00:00Z"),
            sevenDayModels: [UsageModelWindow(model: "Fable", utilization: 88, resetsAt: nil, severity: "warning"),
                             UsageModelWindow(model: "Opus", utilization: nil, resetsAt: nil, severity: nil)]
        )
        let out = UsageLimits.collectProviderLimits(usage: usage, hosts: [], now: now)
        XCTAssertEqual(out.map(\.key), [.claude])
        XCTAssertEqual(out[0].source, "account, live")
        XCTAssertNil(out[0].observedAt)
        XCTAssertEqual(out[0].windows.map(\.label), ["5h", "7d", "7d Fable"])
        XCTAssertEqual(out[0].windows.map(\.window.usedPercent), [31, 52, 88])
        XCTAssertEqual(out[0].windows[0].window.resetsAt, "2026-09-19T23:20:00Z")
    }

    func testUnavailableOrEmptyClaudeIsOmitted() {
        XCTAssertTrue(UsageLimits.collectProviderLimits(usage: nil, hosts: [], now: now).isEmpty)
        XCTAssertTrue(UsageLimits.collectProviderLimits(usage: ClaudeUsageData(available: false), hosts: [], now: now).isEmpty)
        let noNumbers = ClaudeUsageData(available: true, fiveHour: UsageWindow(utilization: nil, resetsAt: nil))
        XCTAssertTrue(UsageLimits.collectProviderLimits(usage: noNumbers, hosts: [], now: now).isEmpty)
    }

    func testCodexPicksFreshestHostAndLabelsByWindowLength() {
        let old = LocalHostAgentLimits.Codex(
            primary: AgentLimitWindow(usedPercent: 90, windowMinutes: 300, resetsAt: "2026-09-20T01:00:00Z"),
            planType: "plus", observedAt: "2026-09-18T10:00:00Z"
        )
        let fresh = LocalHostAgentLimits.Codex(
            primary: AgentLimitWindow(usedPercent: 12, windowMinutes: 300, resetsAt: "2026-09-20T01:00:00Z"),
            secondary: AgentLimitWindow(usedPercent: 40, windowMinutes: 10080, resetsAt: "2026-09-25T00:00:00Z"),
            planType: "pro", observedAt: "2026-09-19T22:00:00Z"
        )
        let out = UsageLimits.collectProviderLimits(usage: nil, hosts: [host("a", codex: old), host("b", codex: fresh), host("c", codex: nil)], now: now)
        XCTAssertEqual(out.map(\.key), [.codex])
        let codex = out[0]
        XCTAssertEqual(codex.observedAt, "2026-09-19T22:00:00Z")
        XCTAssertEqual(codex.planType, "pro")
        XCTAssertEqual(codex.windows.map(\.label), ["5h", "7d"])
        XCTAssertEqual(codex.windows.map(\.window.usedPercent), [12, 40])
        XCTAssertEqual(codex.windows[1].window.windowMinutes, 10080)
    }

    func testCodexWindowThatAlreadyResetReadsZero() {
        let codex = LocalHostAgentLimits.Codex(
            primary: AgentLimitWindow(usedPercent: 5, windowMinutes: 10080, resetsAt: "2026-08-18T07:45:45.000Z"),
            secondary: nil, planType: "prolite", observedAt: "2026-08-11T10:27:17.920Z"
        )
        let out = UsageLimits.collectProviderLimits(usage: nil, hosts: [host("m1", codex: codex)], now: now)
        XCTAssertEqual(out.count, 1)
        XCTAssertEqual(out[0].windows.count, 1)
        XCTAssertEqual(out[0].windows[0].label, "7d")
        XCTAssertEqual(out[0].windows[0].window.usedPercent, 0)
        XCTAssertNil(out[0].windows[0].window.resetsAt)
    }

    func testProviderOrderIsClaudeThenCodex() {
        let usage = ClaudeUsageData(available: true, fiveHour: UsageWindow(utilization: 10, resetsAt: nil))
        let codex = LocalHostAgentLimits.Codex(primary: AgentLimitWindow(usedPercent: 1, windowMinutes: 300, resetsAt: nil), observedAt: "2026-09-19T00:00:00Z")
        let out = UsageLimits.collectProviderLimits(usage: usage, hosts: [host("m1", codex: codex)], now: now)
        XCTAssertEqual(out.map(\.key), [.claude, .codex])
    }

    func testResetsIn() {
        XCTAssertEqual(UsageLimits.resetsIn("2026-09-19T23:06:00Z", now: now), "6m")
        XCTAssertEqual(UsageLimits.resetsIn("2026-09-20T20:46:00Z", now: now), "21h 46m")
        XCTAssertEqual(UsageLimits.resetsIn("2026-09-22T01:00:00Z", now: now), "2d 2h")
        XCTAssertNil(UsageLimits.resetsIn("2026-09-19T22:59:00Z", now: now))
        XCTAssertNil(UsageLimits.resetsIn(nil, now: now))
        XCTAssertNil(UsageLimits.resetsIn("not a date", now: now))
    }

    func testPercentClampsAndRounds() {
        XCTAssertEqual(UsageLimits.percent(30.4), 30)
        XCTAssertEqual(UsageLimits.percent(30.5), 31)
        XCTAssertEqual(UsageLimits.percent(-3), 0)
        XCTAssertEqual(UsageLimits.percent(140), 100)
        XCTAssertEqual(UsageLimits.percent(nil), 0)
    }

    func testSeverityThresholds() {
        XCTAssertEqual(UsageSeverity(percent: 0), .low)
        XCTAssertEqual(UsageSeverity(percent: 49), .low)
        XCTAssertEqual(UsageSeverity(percent: 50), .normal)
        XCTAssertEqual(UsageSeverity(percent: 80), .warning)
        XCTAssertEqual(UsageSeverity(percent: 95), .critical)
        XCTAssertFalse(UsageSeverity(percent: 79).isElevated)
        XCTAssertTrue(UsageSeverity(percent: 80).isElevated)
    }

    func testStaleAge() {
        XCTAssertEqual(UsageLimits.staleAge("2026-09-19T22:59:40Z", now: now), "under a minute")
        XCTAssertEqual(UsageLimits.staleAge("2026-09-19T22:15:00Z", now: now), "45m")
        XCTAssertEqual(UsageLimits.staleAge("2026-09-19T20:00:00Z", now: now), "3h")
        XCTAssertEqual(UsageLimits.staleAge("2026-09-19T20:30:00Z", now: now), "2h 30m")
    }

    func testUsageEnvelopeDecodes() throws {
        let json = """
        {"usage":{"available":true,"fiveHour":{"utilization":31,"resetsAt":"2026-09-19T23:20:00.601836+00:00"},
        "sevenDay":{"utilization":52,"resetsAt":"2026-09-20T21:00:00.601859+00:00"},
        "sevenDayModels":[{"model":"Fable","utilization":12,"resetsAt":null,"severity":null}],
        "extraUsage":{"isEnabled":false,"monthlyLimit":16500,"usedCredits":0,"utilization":0},
        "asOf":"2026-09-19T23:11:13.942Z","hasRecentAuthFailure":false,"authFailures":{"claude":false,"github":false}}}
        """
        struct R: Decodable { var usage: ClaudeUsageData }
        let u = try JSONDecoder().decode(R.self, from: Data(json.utf8)).usage
        XCTAssertTrue(u.available)
        XCTAssertEqual(u.fiveHour?.utilization, 31)
        XCTAssertEqual(u.sevenDayModels?.first?.model, "Fable")
        XCTAssertEqual(u.asOf, "2026-09-19T23:11:13.942Z")
        XCTAssertFalse(u.claudeAuthFailed)
        XCTAssertEqual(UsageLimits.claudeBuckets(u).map(\.label), ["5h", "7d", "7d Fable"])
    }
}
