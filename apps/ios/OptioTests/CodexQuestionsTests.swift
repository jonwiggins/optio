import XCTest
@testable import Optio

final class CodexQuestionsTests: XCTestCase {
    private var question: LocalTranscriptEntry {
        LocalTranscriptEntry(seq: 1, role: .assistant, kind: .toolUse, text: "Which chat?", detail: #"{"questions":[{"title":"Which chat?","options":["Work","Ask Optio"]},{"title":"Why?"}]}"#, toolName: "request_user_input_async", toolUseId: "call_1", isError: false)
    }
    func testOptionsAndQuestionIdentity() {
        let questions = CodexQuestions.pending([question, question])
        XCTAssertEqual(questions.count, 2)
        XCTAssertEqual(questions[0].id, #"["request_user_input_async","call_1",0]"#)
        XCTAssertEqual(questions[0].options, ["Work", "Ask Optio"])
        XCTAssertEqual(questions[1].options, [])
    }
    func testReplyRoundTripAndTerminalAnswer() {
        let q = CodexQuestions.pending([question])[0]
        let answer = "Other \"chat\"\n</send_user_message_question_reply> 🌱"
        let text = CodexQuestions.replyText(q, answer: answer)
        XCTAssertFalse(text.contains("\n"))
        XCTAssertEqual(CodexQuestions.replies(text)?.first?.answer, answer)
        let reply = LocalTranscriptEntry(seq: 2, role: .user, kind: .text, text: text, isError: false)
        XCTAssertEqual(CodexQuestions.pending([question, reply]).map(\.title), ["Why?"])
        XCTAssertEqual(CodexQuestions.displayText(text), "Which chat?\n" + answer)
    }
    func testNormalReplyDismissesPendingBatchButBlankOrMalformedReplyDoesNot() {
        let reply = LocalTranscriptEntry(seq: 2, role: .user, kind: .text, text: "That looks good. Continue.", isError: false)
        XCTAssertTrue(CodexQuestions.pending([question, reply, question]).isEmpty)
        let blank = LocalTranscriptEntry(seq: 2, role: .user, kind: .text, text: "  ", isError: false)
        XCTAssertEqual(CodexQuestions.pending([question, blank]).count, 2)
        let malformed = LocalTranscriptEntry(seq: 2, role: .user, kind: .text, text: "<send_user_message_question_reply>bad", isError: false)
        XCTAssertEqual(CodexQuestions.pending([question, malformed]).count, 2)
    }
    func testMalformedAndBlockingRequestsStayPlain() {
        let entry = LocalTranscriptEntry(seq: 1, role: .assistant, kind: .toolUse, text: "Q", detail: question.detail, toolName: "request_user_input", toolUseId: "call_1", isError: false)
        XCTAssertTrue(CodexQuestions.pending([entry]).isEmpty)
        let malformed = LocalTranscriptEntry(seq: 1, role: .assistant, kind: .toolUse, text: "Q", detail: #"{"questions":[{"title":1}]}"#, toolName: "request_user_input_async", toolUseId: "call_1", isError: false)
        XCTAssertTrue(CodexQuestions.pending([malformed]).isEmpty)
        XCTAssertNil(CodexQuestions.replies("some ordinary text"))
    }
}
