package dev.optio.feature.local.terminal

import android.os.Looper
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalSizing
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.FakeSocket
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.testing.Samples
import dev.optio.feature.local.model.LocalSessionView
import dev.optio.feature.local.snooze.InMemorySnoozePrefs
import dev.optio.feature.local.snooze.SnoozeStore
import dev.optio.feature.local.stream.LocalTerminalStream
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.reflect.KClass
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import okio.ByteString.Companion.encodeUtf8
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * [LocalTerminalViewModel] end to end against [dev.optio.core.testing.FakeOptioServer]: the REST
 * row, the transcript, and the real stream socket (OkHttp WebSocket → FakeSocket) feeding the real
 * `TerminalState`; plus every action's request and the events the screen reacts to.
 */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class LocalTerminalViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    private val store = ViewModelStore()

    @After
    fun tearDown() {
        store.clear()
    }

    private val id = "t1"

    private fun terminalJson(t: LocalTerminal): String = """{"terminal":${OptioJson.encodeToString(LocalTerminal.serializer(), t)}}"""

    private fun serveTerminal(t: LocalTerminal) {
        server.get("/api/local/terminals/:id") { FakeResponse.json(terminalJson(t)) }
    }

    private fun serveBasics(
        t: LocalTerminal,
        transcript: String? = null,
    ) {
        serveTerminal(t)
        server.get("/api/local/hosts") { FakeResponse.json("""{"hosts":[]}""") }
        server.get("/api/local/terminals/:id/transcript") {
            FakeResponse.json(transcript?.let(Fixtures::text) ?: """{"entries":[],"complete":true}""")
        }
    }

    private fun TestScope.newVm(snooze: SnoozeStore = SnoozeStore(InMemorySnoozePrefs(), Samples.clock)): LocalTerminalViewModel {
        val api = server.client()
        val factory =
            object : ViewModelProvider.Factory {
                override fun <T : ViewModel> create(
                    modelClass: KClass<T>,
                    extras: CreationExtras,
                ): T {
                    @Suppress("UNCHECKED_CAST")
                    return LocalTerminalViewModel(api, id, snoozeStore = snooze) as T
                }
            }
        return ViewModelProvider.create(store, factory)[LocalTerminalViewModel::class]
    }

    /** Real-time wait for I/O while running what it resumes (no virtual time passes). */
    private fun TestScope.awaitReal(
        what: String,
        timeoutMs: Long = 5_000,
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            runCurrent()
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    private fun TestScope.events(vm: LocalTerminalViewModel): List<LocalTerminalViewModel.Event> {
        val out = CopyOnWriteArrayList<LocalTerminalViewModel.Event>()
        backgroundScope.launch { vm.events.collect { out += it } }
        return out
    }

    private fun FakeSocket.json(text: String) = sendText(text)

    @Test
    fun aRecordedSessionOpensOnItsTranscriptAndReplaysItsScreenPinned() =
        runTest(main.dispatcher) {
            val recorded = Samples.localTerminal(id = id, state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.NEEDS_YOU, exitCode = 0)
            serveBasics(recorded, transcript = "local-transcript.json")
            val endpoint = server.webSocket("/ws/local/terminals/:id/stream")
            val vm = newVm()
            awaitReal("the transcript") { vm.transcript.state.value.loaded }
            assertEquals(14, vm.transcript.state.value.entries.size)
            assertEquals(LocalSessionView.TRANSCRIPT, vm.sessionView.value)

            vm.attach()
            val socket = endpoint.awaitConnection()
            socket.json("""{"type":"status","state":"exited","attentionState":"needs_you"}""")
            socket.json("""{"type":"size","cols":100,"rows":30}""")
            socket.sendBytes("recorded final screen".encodeUtf8())
            socket.json("""{"type":"exit","exitCode":0}""")
            awaitReal("the exit frame") { vm.streamState.value.settled }
            val s = vm.streamState.value
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(100, 30)), s.mode)
            assertTrue(s.recorded && s.dead && s.outputSeen)
            assertEquals(TerminalGrid(100, 30), vm.screen.grid)
            val text = vm.screen.transcriptText()
            assertTrue("recorded final screen" in text, text)
            assertTrue("[process exited (code 0)]" in text, text)
            assertTrue(socket.received.isEmpty(), "a recorded screen is never resized or typed into")

            vm.detach()
            awaitReal("the socket to close") { socket.closed != null }
            assertNull(vm.stream.value)
        }

    @Test
    fun theComposerWritesTheMessagePlusEnterOverTheStreamWithoutClaimingTheGrid() =
        runTest(main.dispatcher) {
            val live = Samples.localTerminal(id = id, attentionState = LocalAttentionState.WORKING)
            serveBasics(live, transcript = "local-transcript.json")
            val endpoint = server.webSocket("/ws/local/terminals/:id/stream")
            val vm = newVm()
            awaitReal("the row") { vm.terminal.value.value != null }
            vm.attach()
            val socket = endpoint.awaitConnection()
            socket.json("""{"type":"status","state":"running","attentionState":"needs_you"}""")
            socket.json("""{"type":"size","cols":132,"rows":40}""")
            awaitReal("the size frame") { vm.streamState.value.foreignGrid != null }
            assertEquals(LocalAttentionState.NEEDS_YOU, vm.terminal.value.value!!.attentionState, "status frames drive the header")

            backgroundScope.launch { vm.sendToAgent("Looks good, ship it") }
            awaitReal("the input frame") { socket.received.isNotEmpty() }
            val frame = OptioJson.parseToJsonElement(socket.received.single()).jsonObject
            assertEquals("input", frame["type"]!!.jsonPrimitive.content)
            assertEquals("Looks good, ship it\r", frame["data"]!!.jsonPrimitive.content)
            runCurrent()
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(132, 40)), vm.streamState.value.mode, "the composer never claims")
            assertEquals(0, server.count("POST", "/api/local/terminals/:id/input"), "no REST fallback while the stream is up")

            // The transcript is fetched again shortly after, for the prompt the agent just got.
            val before = server.count("GET", "/api/local/terminals/:id/transcript")
            advanceTimeBy(LocalTerminalViewModel.TRANSCRIPT_NUDGE.inWholeMilliseconds + 1)
            awaitReal("the transcript nudge") { server.count("GET", "/api/local/terminals/:id/transcript") > before }
        }

    @Test
    fun withoutAStreamTheComposerFallsBackToRest() =
        runTest(main.dispatcher) {
            serveBasics(Samples.localTerminal(id = id))
            server.post("/api/local/terminals/:id/input") { FakeResponse.json("{}") }
            val vm = newVm()
            awaitReal("the row") { vm.terminal.value.value != null }
            backgroundScope.launch { vm.sendToAgent("hi") }
            awaitReal("the REST input") { server.count("POST", "/api/local/terminals/:id/input") == 1 }
            assertEquals("""{"data":"hi\r"}""", server.lastRequest("POST", "/api/local/terminals/t1/input")!!.body)
        }

    @Test
    fun claimingFromTheScreenResizesThePtyToThePhone() =
        runTest(main.dispatcher) {
            serveBasics(Samples.localTerminal(id = id, spec = dev.optio.core.model.LocalTerminalSpec.Shell, attentionState = LocalAttentionState.WORKING))
            val endpoint = server.webSocket("/ws/local/terminals/:id/stream")
            val vm = newVm()
            awaitReal("the row") { vm.terminal.value.value != null }
            vm.attach()
            val socket = endpoint.awaitConnection()
            socket.json("""{"type":"status","state":"running","attentionState":"working"}""")
            socket.json("""{"type":"size","cols":160,"rows":45}""")
            awaitReal("passive") { vm.streamState.value.foreignGrid == TerminalGrid(160, 45) }
            // No view has laid out in this test, so the phone's fit is unknown: a claim switches to
            // Fit but has nothing to send yet. Input still goes through.
            assertNull(vm.viewChoice.value)
            vm.claim()
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, vm.streamState.value.mode)
            assertEquals(LocalSessionView.SCREEN, vm.viewChoice.value, "using the screen keeps it: a transcript arriving later won't swap the face")
            assertNull(vm.streamState.value.foreignGrid)
            vm.screen.sendText("ls\r")
            awaitReal("the input frame") { socket.received.isNotEmpty() }
            val frame = OptioJson.parseToJsonElement(socket.received.last()).jsonObject
            assertEquals("ls\r", frame["data"]!!.jsonPrimitive.content)
        }

    @Test
    fun actionsHitTheirRoutesAndTellTheScreen() =
        runTest(main.dispatcher) {
            val running = Samples.localTerminal(id = id, attentionState = LocalAttentionState.NEEDS_YOU)
            serveBasics(running)
            server.post("/api/local/terminals/:id/kill") { FakeResponse.json("{}") }
            server.post("/api/local/terminals/:id/snooze") { FakeResponse.json(terminalJson(running.copy(snoozedUntil = Samples.NOW.plusSeconds(900).toString()))) }
            server.post("/api/local/terminals/:id/resume") { FakeResponse.json(terminalJson(running.copy(id = "t2")), 201) }
            server.delete("/api/local/terminals/:id") { FakeResponse.json("{}") }
            val vm = newVm()
            val events = events(vm)
            awaitReal("the row") { vm.terminal.value.value != null }

            vm.kill("SIGKILL")
            awaitReal("kill") { events.any { it is LocalTerminalViewModel.Event.Toast } }
            assertEquals("""{"signal":"SIGKILL"}""", server.lastRequest("POST", "/api/local/terminals/t1/kill")!!.body)
            assertEquals("Kill signal sent (SIGKILL)", (events.first() as LocalTerminalViewModel.Event.Toast).message)

            // One action at a time: the kill's follow-up reload keeps the screen busy until it lands.
            awaitReal("idle") { !vm.busy.value }
            vm.snooze()
            awaitReal("snooze") { events.size >= 2 }
            assertEquals("""{"minutes":15}""", server.lastRequest("POST", "/api/local/terminals/t1/snooze")!!.body)
            assertEquals("Snoozed for 15 min", (events[1] as LocalTerminalViewModel.Event.Toast).message)

            awaitReal("idle") { !vm.busy.value }
            vm.resume()
            awaitReal("resume") { events.any { it is LocalTerminalViewModel.Event.Open } }
            assertEquals(LocalTerminalRoute("t2"), (events.last() as LocalTerminalViewModel.Event.Open).route)

            awaitReal("idle") { !vm.busy.value }
            vm.delete()
            awaitReal("delete") { events.lastOrNull() == LocalTerminalViewModel.Event.Closed }
            assertEquals(1, server.count("DELETE", "/api/local/terminals/:id"))
        }

    @Test
    fun laterFallsBackToThisPhoneWhenTheServerCannotSnooze() =
        runTest(main.dispatcher) {
            serveBasics(Samples.localTerminal(id = id, attentionState = LocalAttentionState.NEEDS_YOU))
            server.error("POST", "/api/local/terminals/:id/snooze", 404, "Not Found")
            val snooze = SnoozeStore(InMemorySnoozePrefs(), Samples.clock)
            val vm = newVm(snooze)
            val events = events(vm)
            awaitReal("the row") { vm.terminal.value.value != null }
            vm.snooze()
            awaitReal("the local snooze") { events.isNotEmpty() }
            assertEquals("Snoozed on this phone for 15 min", (events.single() as LocalTerminalViewModel.Event.Toast).message)
            assertEquals(Samples.NOW.plusSeconds(15 * 60), snooze.snoozedUntil(id))
            assertNotNull(vm.localSnoozeUntil())
        }

    @Test
    fun startingAHeldTerminalReattachesTheStream() =
        runTest(main.dispatcher) {
            val held = Samples.localTerminal(id = id, state = LocalTerminalState.PENDING, attentionState = LocalAttentionState.IDLE)
            serveBasics(held)
            server.post("/api/local/terminals/:id/start") { FakeResponse.json(terminalJson(held.copy(state = LocalTerminalState.LAUNCHING))) }
            val endpoint = server.webSocket("/ws/local/terminals/:id/stream")
            val vm = newVm()
            awaitReal("the row") { vm.terminal.value.value != null }
            awaitReal("the transcript") { vm.transcript.state.value.loaded }
            assertEquals(LocalSessionView.SCREEN, vm.sessionView.value, "no conversation yet: the screen")
            vm.attach()
            val first = endpoint.awaitConnection()
            first.json("""{"type":"status","state":"pending","attentionState":"idle"}""")
            vm.start()
            awaitReal("the second connection") { endpoint.connections.size >= 2 }
            val second = endpoint.awaitConnection() // opened (the upgrade needs no dispatcher)
            assertTrue(second !== first, "leaving pending re-attaches: the server only attaches a launching/running terminal")
            awaitReal("the old socket to close") { first.closed != null }
            assertEquals(LocalTerminalState.LAUNCHING, vm.terminal.value.value!!.state)
            // The new connection is the live one: its status frames reach the header.
            second.json("""{"type":"status","state":"running","attentionState":"working"}""")
            awaitReal("the new socket's status") { vm.terminal.value.value!!.state == LocalTerminalState.RUNNING }
            assertEquals(LocalTerminalStream.ConnState.CONNECTED, vm.streamState.value.conn)
        }
}
