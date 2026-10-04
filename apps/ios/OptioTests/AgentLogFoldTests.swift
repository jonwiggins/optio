import XCTest
@testable import Optio

/// Mirrors `foldTranscript` in `apps/web/src/components/local/transcript-view.test.ts`.
final class AgentLogFoldTests: XCTestCase {
    private func entry(_ type: AgentLogEntry.TypeValue, role: String? = nil, source: String? = nil, error: Bool = false) -> AgentLogEntry {
        var meta: [String: AnyCodable] = [:]
        if let role { meta["role"] = .string(role) }
        if let source { meta["source"] = .string(source) }
        if error { meta["resultIsError"] = .bool(true) }
        return AgentLogEntry(taskId: "t", timestamp: "", type: type, content: "", metadata: meta.isEmpty ? nil : meta)
    }

    private func shape(_ entries: [AgentLogEntry]) -> [String] {
        AgentLogFold.blocks(entries).map {
            switch $0 {
            case .entry(let i): return "e\(i)"
            case .steps(let r): return "s\(r.lowerBound)-\(r.upperBound - 1)"
            }
        }
    }

    func testKeepsOpenerAndLastReplyFoldingTheRest() {
        let log = [
            entry(.text, role: "user"),
            entry(.thinking),
            entry(.toolUse),
            entry(.text),
            entry(.toolUse),
            entry(.text),
            entry(.text, role: "user"),
            entry(.text),
        ]
        XCTAssertEqual(shape(log), ["e0", "s1-4", "e5", "e6", "e7"])
    }

    func testFoldsWorkAfterTheLastReplyAndLeavesALoneStep() {
        XCTAssertEqual(shape([entry(.text, role: "user"), entry(.text), entry(.toolUse), entry(.toolUse)]),
                       ["e0", "e1", "s2-3"])
        XCTAssertEqual(shape([entry(.text, role: "user"), entry(.toolUse), entry(.text)]), ["e0", "e1", "e2"])
    }

    func testSystemTurnsOpenATurn() {
        XCTAssertEqual(shape([entry(.system, source: "task"), entry(.toolUse), entry(.toolUse), entry(.text)]),
                       ["e0", "s1-2", "e3"])
    }

    func testSummarizesSteps() {
        let steps = [entry(.toolUse, error: true), entry(.toolUse), entry(.text), entry(.thinking)]
        XCTAssertEqual(AgentLogFold.summary(steps[...]), "2 tool calls · 1 message · thinking")
        XCTAssertEqual(AgentLogFold.failures(steps[...]), 1)
    }
}
