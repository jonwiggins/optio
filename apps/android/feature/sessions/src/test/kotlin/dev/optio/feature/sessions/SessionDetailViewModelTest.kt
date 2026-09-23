package dev.optio.feature.sessions

import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/** [SessionDetailViewModel]: loading, the chat's lifetime with the screen, PR polling, ending. */
class SessionDetailViewModelTest {
    @get:Rule
    val main = RealMainRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val id = "d95d4894-5728-4125-8700-fca98c9a2166"
    private val events = CopyOnWriteArrayList<SessionDetailViewModel.Event>()
    private val collector = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private lateinit var vm: SessionDetailViewModel

    @Before
    fun setUp() {
        server.fixture("/api/sessions/:id", "session-detail.json")
        server.fixture("/api/sessions/:id/prs", "session-prs.json")
        server.fixture("/api/sessions/:id/chat", "session-chat.json")
    }

    @After
    fun tearDown() {
        main.onMain { vm.disconnect() }
        collector.cancel()
    }

    private fun create(pollMs: Long = 30_000) {
        vm = main.onMain { SessionDetailViewModel(id, server.client(), fastSockets(), prPollInterval = pollMs.milliseconds) }
        collector.launch { vm.events.collect { events += it } }
    }

    @Test
    fun loadsTheSessionAndItsPrsThenChatsWhileShown() {
        create()
        val chat = server.webSocket("/ws/sessions/:id/chat")
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        eventually { vm.session.value.value != null && vm.prs.value.size == 1 }
        assertTrue(vm.isActive)
        val socket = chat.awaitConnection(15_000)
        main.onMain { vm.disconnect() }
        eventually { socket.closed != null }
    }

    @Test
    fun prsArePolledWhileShown() {
        create(pollMs = 100)
        server.webSocket("/ws/sessions/:id/chat")
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        eventually { server.count("GET", "/api/sessions/$id/prs") >= 3 }
        main.onMain { vm.disconnect() }
        Thread.sleep(150)
        val after = server.count("GET", "/api/sessions/$id/prs")
        Thread.sleep(400)
        assertEquals(after, server.count("GET", "/api/sessions/$id/prs"), "no polling off screen")
    }

    @Test
    fun anEndedSessionOpensNoSockets() {
        server.fixture("/api/sessions/:id", "session-detail-ended.json")
        create()
        val chat = server.webSocket("/ws/sessions/:id/chat")
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        eventually { vm.session.value.value != null }
        assertEquals(InteractiveSessionState.ENDED, vm.session.value.value!!.session.state)
        Thread.sleep(300)
        assertTrue(chat.connections.isEmpty())
    }

    @Test
    fun endingClosesTheChatAndShowsTheEndedSession() {
        create()
        val chat = server.webSocket("/ws/sessions/:id/chat")
        val ended = Fixtures.text("session-detail-ended.json").let { text ->
            // The ended fixture's session, as the end route returns it ({ session }).
            val session = dev.optio.core.model.OptioJson.parseToJsonElement(text).let { (it as kotlinx.serialization.json.JsonObject)["session"] }
            """{"session":$session}"""
        }
        server.post("/api/sessions/:id/end") { FakeResponse.json(ended) }
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        val socket = chat.awaitConnection(15_000)
        main.onMain { vm.end() }
        server.awaitRequest("POST", "/api/sessions/$id/end")
        eventually { vm.session.value.value?.session?.state == InteractiveSessionState.ENDED }
        eventually { socket.closed != null }
        eventually { events.any { it == SessionDetailViewModel.Event.Success("Session ended") } }
        assertTrue(!vm.isActive)
    }

    @Test
    fun aFailedEndSaysWhy() {
        create()
        server.error("POST", "/api/sessions/:id/end", 400, "Session already ended")
        main.onMain { vm.appeared() }
        eventually { vm.session.value.value != null }
        main.onMain { vm.end() }
        eventually { events.any { it is SessionDetailViewModel.Event.Failure } }
        assertEquals("Session already ended", (events.single() as SessionDetailViewModel.Event.Failure).error.message)
        assertTrue(vm.isActive)
    }

    @Test
    fun aRefusedChatReloadsTheSession() {
        create()
        val chat = server.webSocket("/ws/sessions/:id/chat")
        main.onMain {
            vm.appeared()
            vm.connect()
        }
        val socket = chat.awaitConnection(15_000)
        val loads = server.count("GET", "/api/sessions/$id")
        server.fixture("/api/sessions/:id", "session-detail-ended.json")
        socket.sendText("""{"type":"error","message":"Session is not active"}""")
        socket.close(1000, "")
        eventually { server.count("GET", "/api/sessions/$id") > loads }
        eventually { vm.session.value.value?.session?.state == InteractiveSessionState.ENDED }
    }
}
