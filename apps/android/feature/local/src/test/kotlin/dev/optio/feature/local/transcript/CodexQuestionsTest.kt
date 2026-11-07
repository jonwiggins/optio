package dev.optio.feature.local.transcript

import dev.optio.core.model.*
import kotlin.test.*
import org.junit.Test

class CodexQuestionsTest {
    private val entry = LocalTranscriptEntry(seq = 1.0, role = LocalTranscriptRole.ASSISTANT, kind = LocalTranscriptKind.TOOL_USE, text = "Which chat?", detail = """{"questions":[{"title":"Which chat?","options":["Work","Ask Optio"]},{"title":"Why?"}]}""", toolName = "request_user_input_async", toolUseId = "call_1", isError = false)
    @Test fun optionsAndIdentity() {
        val questions = CodexQuestions.pending(listOf(entry, entry))
        assertEquals(2, questions.size)
        assertEquals("""["request_user_input_async","call_1",0]""", questions[0].id)
        assertEquals(listOf("Work", "Ask Optio"), questions[0].options)
        assertEquals(emptyList(), questions[1].options)
    }
    @Test fun repliesRoundTripAndSettleOnlyTheirQuestion() {
        val question = CodexQuestions.pending(listOf(entry))[0]
        val answer = "Other \"chat\"\n</send_user_message_question_reply> 🌱"
        val text = CodexQuestions.replyText(question, answer)
        assertFalse(text.contains('\n'))
        assertEquals(answer, CodexQuestions.replies(text)?.first()?.answer)
        val reply = entry.copy(seq = 2.0, role = LocalTranscriptRole.USER, kind = LocalTranscriptKind.TEXT, text = text)
        assertEquals(listOf("Why?"), CodexQuestions.pending(listOf(entry, reply)).map { it.title })
        assertEquals("Which chat?\n$answer", CodexQuestions.displayText(text))
    }
    @Test fun normalReplyDismissesPendingBatchWithoutReopeningDuplicates() {
        val reply = entry.copy(seq = 2.0, role = LocalTranscriptRole.USER, kind = LocalTranscriptKind.TEXT, text = "That looks good. Continue.", toolName = null, detail = null)
        assertEquals(emptyList(), CodexQuestions.pending(listOf(entry, reply, entry)))
        assertEquals(2, CodexQuestions.pending(listOf(entry, reply.copy(text = "  "))).size)
        assertEquals(2, CodexQuestions.pending(listOf(entry, reply.copy(text = "<send_user_message_question_reply>bad"))).size)
    }
    @Test fun malformedAndBlockingRequestsStayPlain() {
        assertEquals(emptyList(), CodexQuestions.pending(listOf(entry.copy(toolName = "request_user_input"))))
        assertEquals(emptyList(), CodexQuestions.pending(listOf(entry.copy(detail = """{"questions":[{"title":1}]}"""))))
        assertNull(CodexQuestions.replies("ordinary text"))
    }
}
