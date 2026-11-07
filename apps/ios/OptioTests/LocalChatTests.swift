import XCTest
@testable import Optio

final class LocalChatTests: XCTestCase {
    private func entry(_ seq: Double, _ text: String, role: LocalTranscriptRole = .user,
                       source: LocalTranscriptSource? = nil) -> LocalTranscriptEntry {
        LocalTranscriptEntry(seq: seq, role: role, kind: .text, source: source, text: text, isError: false)
    }

    func testImmediateFeedbackAndOneEchoPerSubmission() {
        var outbox = LocalChatOutbox()
        let first = outbox.begin("Hello\nworld", afterSeq: 10)
        let second = outbox.begin("Hello\nworld", afterSeq: 10)
        XCTAssertEqual(outbox.logEntries(terminalId: "t").count, 2)
        XCTAssertEqual(outbox.messages.first?.delivery, .sending)
        outbox.settle(first, delivery: .sent)
        outbox.reconcile([entry(11, "Hello\r\nworld")])
        XCTAssertEqual(outbox.messages.map(\.id), [second])
        outbox.reconcile([entry(12, "Hello\nworld")])
        XCTAssertTrue(outbox.messages.isEmpty)
    }

    func testOldHistoryAndNonUserMessagesCannotAcknowledgeASend() {
        var outbox = LocalChatOutbox()
        let id = outbox.begin("same", afterSeq: 10)
        outbox.reconcile([entry(9, "same"), entry(11, "same", role: .assistant), entry(12, "same", source: .prompt)])
        XCTAssertEqual(outbox.messages.map(\.id), [id])
        outbox.settle(id, delivery: .uncertain)
        XCTAssertEqual(outbox.messages.first?.text, "same")
        outbox.reconcile([entry(13, "same")])
        XCTAssertTrue(outbox.messages.isEmpty, "A late transcript echo settles uncertain delivery")
        outbox.settle(id, delivery: .sent)
        XCTAssertTrue(outbox.messages.isEmpty, "A late transport response cannot resurrect a bubble")
    }

    @MainActor
    func testModelShowsMessageWhileTransportIsSuspendedAndPreservesFailure() async {
        let model = LocalTranscriptModel(api: APIClient(), terminalId: "t")
        let started = expectation(description: "transport started")
        var continuation: CheckedContinuation<Void, Error>?
        let send = Task {
            await model.send("Keep this message") { _ in
                try await withCheckedThrowingContinuation { continuation = $0; started.fulfill() }
            }
        }
        await fulfillment(of: [started], timeout: 2)
        XCTAssertEqual(model.logEntries.last?.content, "Keep this message")
        XCTAssertEqual(model.outbox.messages.first?.delivery, .sending)
        continuation?.resume(throwing: URLError(.networkConnectionLost))
        await send.value
        XCTAssertEqual(model.outbox.messages.first?.delivery, .uncertain)
        XCTAssertEqual(model.logEntries.last?.content, "Keep this message")
    }

    func testActivityDistinguishesWorkWaitingAndFinishedWithoutGuessingFromText() {
        func activity(_ state: LocalTerminalState = .running, _ attention: LocalAttentionState = .working,
                      connected: Bool = true, pending: Bool = false, kind: LocalTranscriptKind? = nil) -> LocalChatActivity {
            .resolve(state: state, attention: attention, connected: connected, hasPendingMessage: pending, latestKind: kind)
        }
        XCTAssertEqual(activity(kind: .thinking).title, "Thinking…")
        XCTAssertEqual(activity(kind: .toolUse).title, "Working…")
        XCTAssertTrue(activity(kind: .text).active, "Commentary is not proof of completion")
        XCTAssertEqual(activity(.running, .needsYou).title, "Waiting for you")
        XCTAssertEqual(activity(.running, .idle).title, "Ready for your next message")
        XCTAssertEqual(activity(.running, .idle, pending: true).symbol, "clock")
        XCTAssertFalse(activity(connected: false).active)
        XCTAssertTrue(activity(connected: false).title.contains("Reconnecting"))
        XCTAssertEqual(activity(.exited, connected: false).title, "Session finished")
        XCTAssertEqual(activity(.error).title, "Session failed")
    }
}
