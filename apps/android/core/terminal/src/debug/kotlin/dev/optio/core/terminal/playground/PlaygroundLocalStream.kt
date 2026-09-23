package dev.optio.core.terminal.playground

import android.os.Handler
import android.os.Looper
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import dev.optio.core.terminal.StreamPolicy
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import dev.optio.core.terminal.TerminalSizing
import dev.optio.core.terminal.TerminalState
import dev.optio.core.terminal.gridMode
import java.util.concurrent.TimeUnit
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.json.JSONObject

/**
 * The playground's live Optio Local viewer: `/ws/local/terminals/:id/stream` over OkHttp, a compact
 * port of iOS `LocalTerminalStream` driving the component the way `:feature:local` will. Binary
 * frames are PTY bytes (the scrollback replay is held until the daemon's `size` frame); JSON frames
 * are `status` / `size` / `exit` / `error`; we send JSON `input` and `resize`. One PTY, one grid:
 * attaching never resizes it; an explicit interaction (tap, key, "Use this screen") claims it.
 */
internal class PlaygroundLocalStream(
    private val baseUrl: String,
    private val token: String,
    private val terminalId: String,
    private val terminal: TerminalState,
) {
    enum class Conn { Connecting, Connected, Reconnecting, Disconnected }

    var conn by mutableStateOf(Conn.Connecting)
        private set
    var mode: TerminalSizing.Mode by mutableStateOf(TerminalSizing.Mode.Unclaimed)
        private set
    var recorded by mutableStateOf(false)
        private set
    var status by mutableStateOf<String?>(null)
        private set
    var error by mutableStateOf<String?>(null)
        private set

    val foreignGrid: TerminalGrid? get() = (mode as? TerminalSizing.Mode.Passive)?.grid

    private val client = OkHttpClient.Builder().readTimeout(0, TimeUnit.SECONDS).pingInterval(25, TimeUnit.SECONDS).build()
    private val main = Handler(Looper.getMainLooper())
    private var ws: WebSocket? = null
    private var generation = 0
    private var sent = emptyList<TerminalGrid>()
    private var announced: TerminalGrid? = null
    private var dead = false
    private var pendingReset = false
    private var disposed = false
    private var retryRequested = false
    private var liveOnThisConnection = false

    fun connect() {
        if (disposed) return
        ws?.cancel()
        val gen = ++generation
        liveOnThisConnection = false
        terminal.hold() // until the size frame lands (or 1.5 s)
        if (conn != Conn.Reconnecting) conn = Conn.Connecting
        val url = baseUrl.trimEnd('/').replaceFirst(Regex("^http"), "ws") + "/ws/local/terminals/$terminalId/stream"
        val request = Request.Builder().url(url).header("Sec-WebSocket-Protocol", "optio-ws-v1, optio-auth-$token").build()
        ws =
            client.newWebSocket(
                request,
                object : WebSocketListener() {
                    override fun onOpen(webSocket: WebSocket, response: Response) {
                        main.post { if (gen == generation) onOpened() }
                    }

                    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
                        val data = bytes.toByteArray()
                        main.post { if (gen == generation) onBinary(data) }
                    }

                    override fun onMessage(webSocket: WebSocket, text: String) {
                        main.post { if (gen == generation) onText(text) }
                    }

                    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                        webSocket.close(1000, null)
                    }

                    override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                        main.post { if (gen == generation) onClosed(code) }
                    }

                    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                        main.post { if (gen == generation) onClosed(1006) }
                    }
                },
            )
    }

    fun dispose() {
        disposed = true
        generation++
        main.removeCallbacksAndMessages(null)
        ws?.close(1000, null)
        ws = null
        terminal.release()
        client.dispatcher.executorService.shutdown()
    }

    // region Terminal → stream

    fun onInteraction() {
        if (mode != TerminalSizing.Mode.Owner) claim()
    }

    fun onGridSizeChanged(grid: TerminalGrid) {
        if (mode == TerminalSizing.Mode.Owner) sendResize(grid)
    }

    fun onNaturalGridChanged() {
        announced?.let { gridAnnounced(it) }
    }

    fun sendInput(bytes: ByteArray) {
        if (conn != Conn.Connected) return
        ws?.send(JSONObject().put("type", "input").put("data", String(bytes, Charsets.UTF_8)).toString())
    }

    /** This screen is being used: size the PTY to it (never for a finished terminal). */
    fun claim() {
        if (dead || disposed) return
        mode = TerminalSizing.Mode.Owner
        terminal.gridMode = TerminalGridMode.Fit
        if (terminal.naturalGrid != null) sendResize(terminal.grid)
    }

    // endregion

    // region Stream → terminal

    private fun onOpened() {
        conn = Conn.Connected
        error = null
        if (mode == TerminalSizing.Mode.Owner) sendResize(terminal.grid)
    }

    private fun onBinary(data: ByteArray) {
        if (pendingReset) {
            pendingReset = false
            terminal.reset()
        }
        terminal.feed(data)
    }

    private fun onText(text: String) {
        val msg = runCatching { JSONObject(text) }.getOrNull() ?: return terminal.feed(text)
        when (msg.optString("type")) {
            "status" -> {
                val state = msg.optString("state")
                if (StreamPolicy.isTerminalStateDead(state)) dead = true else liveOnThisConnection = true
                status = "$state · ${msg.optString("attentionState")}"
            }
            "size" -> {
                val cols = msg.optInt("cols")
                val rows = msg.optInt("rows")
                if (cols > 0 && rows > 0) gridAnnounced(TerminalGrid(cols, rows))
                // Everything before this frame was the scrollback replay: don't answer its queries.
                terminal.release(suppressReplies = true)
            }
            "exit" -> {
                dead = true
                terminal.release()
                val code = if (msg.isNull("exitCode")) null else msg.optInt("exitCode")
                terminal.feed("\r\n\u001b[2m[process exited${code?.let { " (code $it)" } ?: ""}]\u001b[0m\r\n")
                status = "exited"
            }
            "error" -> {
                error = msg.optString("message")
                terminal.release()
                if (liveOnThisConnection && !dead) {
                    retryRequested = true
                    ws?.close(1000, null)
                    scheduleReconnect()
                }
            }
        }
    }

    private fun onClosed(code: Int) {
        if (disposed) return
        terminal.release()
        val action = StreamPolicy.closeAction(code, terminalDead = dead, retryRequested = retryRequested)
        retryRequested = false
        when (action) {
            is StreamPolicy.CloseAction.Stop -> {
                conn = Conn.Disconnected
                action.message?.let { error = it }
            }
            StreamPolicy.CloseAction.Reconnect -> scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (disposed) return
        conn = Conn.Reconnecting
        pendingReset = true
        main.postDelayed({ if (!disposed) connect() }, 2_000)
    }

    private fun gridAnnounced(grid: TerminalGrid) {
        announced = grid
        val natural = terminal.naturalGrid ?: TerminalGrid(0, 0)
        mode = TerminalSizing.onGridAnnounced(mode, grid, natural, sent, recorded = dead)
        TerminalSizing.ackSentGrid(sent, grid)?.let { sent = it }
        if (dead) recorded = true
        terminal.gridMode = mode.gridMode
    }

    private fun sendResize(grid: TerminalGrid) {
        if (grid.cols <= 0 || grid.rows <= 0) return
        sent = TerminalSizing.pushSentGrid(sent, grid)
        if (conn != Conn.Connected) return
        ws?.send(JSONObject().put("type", "resize").put("cols", grid.cols).put("rows", grid.rows).toString())
    }

    // endregion
}
