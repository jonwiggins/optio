import XCTest
@testable import Optio

@MainActor
final class SessionChatModelTests: XCTestCase {
    private func ready() -> SessionChatModel {
        let model = SessionChatModel(sessionId: "session", api: APIClient())
        model.handle(.json(["type": "status", "status": "ready"]))
        model.handle(.json(["type": "history_done", "count": 0]))
        return model
    }

    func testSendAppearsImmediatelyAndEchoKeepsOneBubble() throws {
        let model = ready()
        let frame = try XCTUnwrap(model.prepareSend("  Hello\nworld  "))
        let id = try XCTUnwrap(frame["requestId"] as? String)
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertEqual(model.logEntries[0].content, "Hello\nworld")
        XCTAssertEqual(model.deliveries[id], "Sending…")
        XCTAssertTrue(model.isThinking)
        XCTAssertNil(model.prepareSend("double tap"))
        model.handle(.json(["type": "user_message", "content": "Hello\nworld", "requestId": id]))
        model.handle(.json(["type": "user_message", "content": "Hello\nworld", "requestId": id]))
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertEqual(model.deliveries[id], "Sent")
    }

    func testExecutionAndApprovalNeverLookFinished() {
        let model = ready()
        model.handle(.json(["type": "status", "status": "executing"]))
        XCTAssertTrue(model.isThinking)
        XCTAssertFalse(model.canSend)
        XCTAssertEqual(model.activityTitle, "Working…")
        model.handle(.json(["type": "status", "status": "waiting_for_approval"]))
        XCTAssertFalse(model.isThinking)
        XCTAssertFalse(model.canSend)
        XCTAssertTrue(model.activityTitle.contains("Waiting for approval"))
        model.handle(.json(["type": "status", "status": "idle"]))
        XCTAssertTrue(model.canSend)
        XCTAssertEqual(model.activityTitle, "Ready for your next message")
        model.handle(.json(["type": "status", "status": "future_status"]))
        XCTAssertFalse(model.canSend)
    }

    func testSilentTurnStaysActiveUntilStatusSaysItEnded() {
        let model = ready()
        _ = model.prepareSend("Please work")
        model.handle(.json(["type": "chat_event", "event": [
            "taskId": "session", "timestamp": "2026-11-06T12:00:00Z", "type": "text", "content": "I’ll check."
        ]]))
        XCTAssertTrue(model.isThinking, "An assistant message can be commentary, not a final answer")
        model.handle(.json(["type": "status", "status": "ready"]))
        XCTAssertFalse(model.isThinking)
    }

    func testDisconnectPreservesUncertainMessageAndLateEchoSettlesIt() throws {
        let model = ready()
        let frame = try XCTUnwrap(model.prepareSend("hello"))
        let id = try XCTUnwrap(frame["requestId"] as? String)
        model.handle(.closed(code: 1006, reason: nil))
        XCTAssertFalse(model.isThinking)
        XCTAssertFalse(model.canSend)
        XCTAssertTrue(model.deliveries[id]?.contains("unconfirmed") == true)
        model.handle(.json(["type": "user_message", "content": "hello", "requestId": id]))
        XCTAssertEqual(model.rows.count, 1)
        XCTAssertEqual(model.deliveries[id], "Sent")
    }

    func testRejectedSendStopsThinkingAndRetainsText() {
        let model = ready()
        _ = model.prepareSend("hello")
        model.handle(.json(["type": "error", "message": "Session has ended"]))
        XCTAssertFalse(model.isThinking)
        XCTAssertEqual(model.error, "Session has ended")
        XCTAssertEqual(model.logEntries.first?.content, "hello")
    }

    func testQueueAcknowledgementIsDistinctFromSent() throws {
        let model = ready()
        let frame = try XCTUnwrap(model.prepareSend("next"))
        let id = try XCTUnwrap(frame["requestId"] as? String)
        model.handle(.json(["type": "queue", "messages": [["requestId": id, "content": "next"]]]))
        XCTAssertEqual(model.deliveries[id], "Queued")
        model.handle(.json(["type": "user_message", "content": "next", "requestId": id]))
        XCTAssertEqual(model.deliveries[id], "Sent")
        XCTAssertEqual(model.rows.count, 1)
    }

    func testReconnectReplacesHistoryAndRecoversMissedReplyWithoutDuplicatingSend() throws {
        let model = ready()
        let frame = try XCTUnwrap(model.prepareSend("hello"))
        let id = try XCTUnwrap(frame["requestId"] as? String)
        model.handle(.closed(code: 1006, reason: nil))
        model.handle(.opened)
        model.handle(.json(["type": "status", "status": "ready", "runtime": "codex"]))
        XCTAssertFalse(model.canSend, "Wait for replay before accepting another message")
        func replay(_ type: String, _ content: String, frame: [String: Any]) {
            model.handle(.json(["type": "chat_event", "catchUp": true, "event": [
                "taskId": "session", "timestamp": "2026-11-06T12:00:00Z", "type": type,
                "content": content, "metadata": ["frame": frame]
            ]]))
        }
        replay("user_message", "hello", frame: ["type": "user_message", "requestId": id])
        replay("text", "Hello ", frame: ["type": "text"])
        replay("text", "there", frame: ["type": "text"])
        model.handle(.json(["type": "history_done", "count": 3]))
        XCTAssertEqual(model.logEntries.map(\.content), ["hello", "Hello there"])
        XCTAssertEqual(model.deliveries[id], "Sent")
        XCTAssertTrue(model.canSend)
    }

    func testHarnessFragmentsRemainOneReadableReply() {
        let model = ready()
        model.handle(.json(["type": "status", "status": "thinking", "runtime": "codex"]))
        for content in ["A **read", "able** reply."] {
            model.handle(.json(["type": "chat_event", "event": [
                "taskId": "session", "timestamp": "2026-11-06T12:00:00Z", "type": "text", "content": content
            ]]))
        }
        XCTAssertEqual(model.logEntries.map(\.content), ["A **readable** reply."])
        XCTAssertTrue(model.isThinking)
    }
}
