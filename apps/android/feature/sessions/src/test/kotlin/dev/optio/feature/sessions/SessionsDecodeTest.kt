package dev.optio.feature.sessions

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.OptioJson
import dev.optio.core.model.SessionChatClientMessage
import dev.optio.core.model.SessionChatEvent
import dev.optio.core.model.SessionChatServerMessage
import dev.optio.core.model.SessionChatStatus
import dev.optio.core.model.SessionPr
import dev.optio.core.model.boolValue
import dev.optio.core.testing.Fixtures
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** Session responses and chat frames captured from the private test API decode as the app reads them. */
class SessionsDecodeTest {
    @Serializable
    private data class Chat(val events: List<SessionChatHistoryEvent>)

    @Serializable
    private data class Prs(val prs: List<SessionPr>)

    @Test
    fun activeSessionWithModelConfig() {
        val envelope = Fixtures.decode<SessionEnvelope>("session-detail.json")
        val session = envelope.session
        assertEquals(InteractiveSessionState.ACTIVE, session.state)
        assertEquals("Investigate slow cold start", session.title)
        assertEquals("session/anon/fb812229", session.branch)
        assertEquals("0.0123", session.costUsd)
        assertNull(session.endedAt)
        assertEquals(listOf("haiku", "sonnet", "opus"), envelope.modelConfig?.availableModels)
        assertEquals("opus", envelope.modelConfig?.claudeModel)
        assertEquals("Investigate slow cold start", sessionTitle(session))
        assertEquals(0.0123, displayCost(0.0, session))
        assertEquals(0.5, displayCost(0.5, session))
    }

    @Test
    fun endedSession() {
        val session = Fixtures.decode<SessionEnvelope>("session-detail-ended.json").session
        assertEquals(InteractiveSessionState.ENDED, session.state)
        assertTrue(session.endedAt!!.isNotEmpty())
        assertNull(session.costUsd)
        assertEquals("session/anon/fb812229", sessionTitle(session.copy(title = null, branch = "session/anon/fb812229")))
        assertEquals("Session 165a1e17", sessionTitle(session.copy(title = " ", branch = "")))
    }

    @Test
    fun chatHistoryMarksWhatYouTyped() {
        val events = Fixtures.decode<Chat>("session-chat.json").events
        val typed = events.filter { it.isUserMessage }
        assertEquals(3, typed.size)
        assertEquals("Profile the app's cold start and list the three slowest steps.", typed.first().content)
        val entries = events.filterNot { it.isUserMessage }.map { it.asLogEntry("s1") }
        assertTrue(entries.map { it.type }.toSet() == setOf(AgentLogEntry.TypeValue.TEXT, AgentLogEntry.TypeValue.SYSTEM, AgentLogEntry.TypeValue.INFO))
        assertTrue(entries.all { it.timestamp.isNotEmpty() })
    }

    @Test
    fun prs() {
        val pr = Fixtures.decode<Prs>("session-prs.json").prs.single()
        assertEquals(77.0, pr.prNumber)
        assertEquals("open", pr.prState)
        assertEquals("pending", pr.prChecksStatus)
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/77", pr.prUrl)
    }

    @Test
    fun chatSocketFrames() {
        val frames = Fixtures.text("session-chat-frames.jsonl").lines().filter { it.isNotBlank() }.map { OptioJson.parseToJsonElement(it).jsonObject }
        val messages = frames.map { OptioJson.decodeFromJsonElement(SessionChatServerMessage.serializer(), it) }
        val ready = assertIs<SessionChatServerMessage.Status>(messages.first())
        assertEquals(SessionChatStatus.READY, ready.status)
        assertEquals("sonnet", ready.model)
        // The replay: flagged, and a typed prompt comes back as an event type the model doesn't know.
        val replay = frames.drop(1).takeWhile { it["catchUp"]?.boolValue == true }
        assertTrue(replay.size >= 4)
        val typed = messages.drop(1).take(replay.size).filterIsInstance<SessionChatServerMessage.ChatEvent>().filter { it.event.type == SessionChatEvent.TypeValue.UNKNOWN }
        assertTrue(typed.isNotEmpty())
        assertTrue(messages.any { it is SessionChatServerMessage.Status && it.status == SessionChatStatus.THINKING })
        assertEquals(0.0123, messages.filterIsInstance<SessionChatServerMessage.CostUpdate>().single().costUsd)
        assertEquals(SessionChatStatus.IDLE, (messages.last() as SessionChatServerMessage.Status).status)
    }

    @Test
    fun clientFramesCarryTheirType() {
        fun encode(message: SessionChatClientMessage) = OptioJson.encodeToString(SessionChatClientMessage.serializer(), message)
        assertEquals("""{"type":"message","content":"hi"}""", encode(SessionChatClientMessage.Message("hi")))
        assertEquals("""{"type":"interrupt"}""", encode(SessionChatClientMessage.Interrupt))
        assertEquals("""{"type":"set_model","model":"opus"}""", encode(SessionChatClientMessage.SetModel("opus")))
    }
}
