package dev.optio.feature.sessions

import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.model.intValue
import dev.optio.core.model.stringValue
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeSocket
import dev.optio.core.testing.FakeSocketEndpoint
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject
import okio.ByteString.Companion.encodeUtf8
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The session shell end to end under Robolectric: a real [TerminalState] laid out by
 * [SessionTerminalView], a [SessionTerminalController] on a fake `/ws/sessions/:id/terminal`
 * (the fake container runtime closes session terminals at once, so the socket is played here).
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class SessionTerminalTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    private fun show(endpoint: FakeSocketEndpoint): Pair<SessionTerminalController, FakeSocket> {
        lateinit var controller: SessionTerminalController
        compose.setContent {
            val scope = rememberCoroutineScope()
            controller = remember { SessionTerminalController("s1", server.client(), scope, socketFactory = fastSockets()) }
            val connected by controller.connected.collectAsState()
            val error by controller.error.collectAsState()
            val stopped by controller.stopped.collectAsState()
            OptioTheme(darkTheme = true) {
                SessionTerminalView(
                    terminal = controller.terminal,
                    ui = SessionTerminalUi(connected, error, stopped),
                    onReconnect = { controller.reconnect() },
                    modifier = Modifier.fillMaxSize(),
                    focusOnShow = false,
                )
            }
        }
        compose.waitUntil(5_000) { controller.terminal.naturalGrid != null }
        compose.runOnIdle { controller.start() }
        val socket = endpoint.awaitConnection(15_000)
        compose.waitUntil(5_000) { controller.connected.value }
        return controller to socket
    }

    private fun FakeSocket.receivedInput(): String = receivedBytes.joinToString("") { it.utf8() }

    @Test
    fun thePhoneOwnsTheGridAndBytesFlowBothWays() {
        val (controller, socket) = show(server.webSocket("/ws/sessions/:id/terminal"))
        // On open the PTY is sized to what the terminal laid out at.
        val resize = Json.parseToJsonElement(socket.awaitText()).jsonObject
        val grid = compose.runOnIdle { controller.terminal.grid }
        assertEquals("resize", resize["type"]?.stringValue)
        assertEquals(grid.cols, resize["cols"]?.intValue)
        assertEquals(grid.rows, resize["rows"]?.intValue)
        assertTrue(grid.cols in 30..120 && grid.rows in 10..80, "phone grid $grid")

        socket.sendBytes("jon@pod:~/repo$ echo hi\r\nhi\r\njon@pod:~/repo$ ".encodeUtf8())
        compose.waitUntil(5_000) { controller.terminal.screenText().contains("hi\njon@pod:~/repo$") }

        compose.runOnIdle { controller.terminal.sendText("ls -la\r") }
        compose.waitUntil(5_000) { socket.receivedInput() == "ls -la\r" }
    }

    @Test
    fun anErrorFrameStopsAndOffersReconnect() {
        val endpoint = server.webSocket("/ws/sessions/:id/terminal")
        val (controller, socket) = show(endpoint)
        socket.sendText("""{"error":"Session pod was cleaned up due to inactivity. Please end this session and start a new one."}""")
        socket.close(1000, "")
        compose.waitUntil(5_000) { controller.stopped.value }
        assertTrue(controller.error.value!!.startsWith("Session pod was cleaned up"))
        assertTrue(controller.terminal.transcriptText().contains("[disconnected]"))
        Thread.sleep(400)
        assertEquals(1, endpoint.connections.size, "no retry after an error frame")

        compose.onNodeWithTag("terminal-reconnect").performClick()
        endpoint.awaitConnection(15_000)
        compose.waitUntil(5_000) { controller.connected.value && !controller.stopped.value }
    }

    @Test
    fun aShellThatKeepsClosingGivesUp() {
        val endpoint = server.webSocket("/ws/sessions/:id/terminal")
        val (controller, first) = show(endpoint)
        first.close(1000, "")
        endpoint.awaitConnection(15_000).close(1000, "")
        endpoint.awaitConnection(15_000).close(1000, "")
        compose.waitUntil(5_000) { controller.stopped.value }
        assertEquals("The terminal keeps closing. The session's pod may be gone.", controller.error.value)
        Thread.sleep(400)
        assertEquals(3, endpoint.connections.size)
    }

    @Test
    fun aDropWithOutputReconnects() {
        val endpoint = server.webSocket("/ws/sessions/:id/terminal")
        val (controller, first) = show(endpoint)
        first.sendBytes("$ ".encodeUtf8())
        compose.waitUntil(5_000) { controller.terminal.screenText().contains("$") }
        first.close(1001, "going away")
        val second = endpoint.awaitConnection(15_000)
        compose.waitUntil(5_000) { controller.connected.value }
        assertEquals("resize", Json.parseToJsonElement(second.awaitText()).jsonObject["type"]?.stringValue)
        assertTrue(!controller.stopped.value)
    }
}
