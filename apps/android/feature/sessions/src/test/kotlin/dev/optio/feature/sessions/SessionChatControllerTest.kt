package dev.optio.feature.sessions

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.stringValue
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeSocket
import dev.optio.core.testing.FakeSocketEndpoint
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * [SessionChatController] against a fake API and chat socket: history first, the replay gate before
 * sending, the conversation's frames, and what happens when the socket drops or is refused.
 */
class SessionChatControllerTest {
    @get:Rule
    val main = RealMainRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val id = "d95d4894-5728-4125-8700-fca98c9a2166"
    private lateinit var scope: CoroutineScope
    private lateinit var chat: SessionChatController
    private lateinit var endpoint: FakeSocketEndpoint

    @Before
    fun setUp() {
        server.fixture("/api/sessions/:id/chat", "session-chat.json")
        endpoint = server.webSocket("/ws/sessions/:id/chat")
        scope = CoroutineScope(SupervisorJob() + main.dispatcher)
        chat = SessionChatController(id, server.client(), scope, fastSockets(), settleDelay = 200.milliseconds)
    }

    @After
    fun tearDown() {
        main.onMain { chat.stop() }
        scope.cancel()
    }

    private fun start(): FakeSocket {
        main.onMain { chat.start() }
        return endpoint.awaitConnection(15_000)
    }

    private fun FakeSocket.ready(model: String = "sonnet") = sendText("""{"type":"status","status":"ready","model":"$model","costUsd":0}""")

    private fun FakeSocket.event(type: String, content: String, catchUp: Boolean = false) =
        sendText(
            """{"type":"chat_event","event":{"taskId":"$id","timestamp":"2026-09-23T01:00:00Z","type":"$type","content":"$content"}${if (catchUp) ""","catchUp":true""" else ""}}""",
        )

    @Test
    fun historyFirstThenTheSocket() {
        val socket = start()
        eventually { chat.historyLoaded.value }
        val rows = chat.rows.value
        assertEquals(12, rows.size)
        assertIs<SessionChatRow.User>(rows.first())
        assertEquals(3, rows.count { it is SessionChatRow.User })
        assertEquals("1000", server.lastRequest("GET", "/api/sessions/$id/chat")!!.queryParam("limit"))
        assertTrue(socket.request.header("Sec-WebSocket-Protocol")!!.contains("optio-ws-v1"))
    }

    @Test
    fun sendingWaitsForReadyAndTheReplay() {
        val socket = start()
        eventually { chat.historyLoaded.value }
        assertFalse(chat.canSend.value)
        assertFalse(main.onMain { chat.send("too early") })

        socket.ready(model = "opus")
        eventually { chat.status.value == SessionChatConnection.READY }
        assertEquals("opus", chat.model.value)
        // The replay: skipped (REST had it), but it keeps the gate shut until it goes quiet.
        repeat(4) {
            socket.event("text", "old $it", catchUp = true)
            Thread.sleep(60)
        }
        assertFalse(chat.canSend.value, "still replaying")
        assertEquals(12, chat.rows.value.size)
        eventually { chat.canSend.value }

        assertTrue(main.onMain { chat.send("  Which step is slowest?  ") })
        val frame = Json.parseToJsonElement(socket.awaitText()).jsonObject
        assertEquals("message", frame["type"]?.stringValue)
        assertEquals("Which step is slowest?", frame["content"]?.stringValue)
        assertEquals(SessionChatRow.User(chat.rows.value.last().id, "Which step is slowest?"), chat.rows.value.last())
        assertEquals(SessionChatConnection.THINKING, chat.status.value)
        assertFalse(chat.canSend.value)
    }

    @Test
    fun theConversationStreamsIn() {
        val socket = start()
        eventually { chat.historyLoaded.value }
        socket.ready()
        eventually { chat.canSend.value }
        main.onMain { chat.send("go") }
        socket.awaitText()
        socket.sendText("""{"type":"status","status":"thinking"}""")
        socket.event("system", "Session started · fake-model · 0 tools")
        socket.event("text", "Mock agent handled: go")
        socket.sendText("""{"type":"cost_update","costUsd":0.0246}""")
        socket.sendText("""{"type":"status","status":"idle"}""")
        eventually { chat.status.value == SessionChatConnection.IDLE }
        val tail = chat.rows.value.takeLast(2).map { (it as SessionChatRow.Entry).entry }
        assertEquals(listOf(AgentLogEntry.TypeValue.SYSTEM, AgentLogEntry.TypeValue.TEXT), tail.map { it.type })
        assertEquals("Mock agent handled: go", tail.last().content)
        assertEquals(0.0246, chat.costUsd.value)
        assertTrue(chat.canSend.value)
    }

    @Test
    fun interruptAndModelFrames() {
        val socket = start()
        eventually { chat.historyLoaded.value }
        socket.ready()
        eventually { chat.status.value == SessionChatConnection.READY }
        main.onMain {
            chat.setModel("haiku")
            chat.interrupt()
        }
        assertEquals("""{"type":"set_model","model":"haiku"}""", socket.awaitText())
        assertEquals("""{"type":"interrupt"}""", socket.awaitText())
        assertEquals("haiku", chat.model.value)
    }

    @Test
    fun theReplayStandsInWhenTheHistoryFailed() {
        server.error("GET", "/api/sessions/:id/chat", 500, "boom")
        val socket = start()
        eventually { chat.error.value != null }
        socket.ready()
        socket.event("user_message", "Profile the cold start", catchUp = true)
        socket.event("text", "On it", catchUp = true)
        eventually { chat.rows.value.size == 2 }
        assertEquals(SessionChatRow.User(chat.rows.value.first().id, "Profile the cold start"), chat.rows.value.first())
        assertEquals("On it", (chat.rows.value.last() as SessionChatRow.Entry).entry.content)
        // A `ready` clears the history error once the chat works.
        eventually { chat.error.value == null }
    }

    @Test
    fun aRefusedChatIsNotRetried() {
        val socket = start()
        eventually { chat.historyLoaded.value }
        socket.sendText("""{"type":"error","message":"Session is not active"}""")
        socket.close(1000, "")
        eventually { chat.fatal.value }
        assertEquals("Session is not active", chat.error.value)
        assertEquals(SessionChatConnection.DISCONNECTED, chat.status.value)
        Thread.sleep(500)
        assertEquals(1, endpoint.connections.size, "no reconnect")
        // Starting again (the screen came back) tries once more.
        main.onMain { chat.start() }
        endpoint.awaitConnection(15_000)
    }

    @Test
    fun aDropReconnectsAndReloadsTheHistory() {
        val first = start()
        eventually { chat.historyLoaded.value }
        first.ready()
        eventually { chat.canSend.value }
        val historyLoads = server.count("GET", "/api/sessions/$id/chat")
        first.close(1011, "restart")
        eventually { chat.status.value == SessionChatConnection.DISCONNECTED }
        assertFalse(chat.canSend.value)
        val second = endpoint.awaitConnection(15_000)
        eventually { server.count("GET", "/api/sessions/$id/chat") > historyLoads }
        second.ready()
        eventually { chat.canSend.value }
        assertEquals(12, chat.rows.value.size)
    }
}
