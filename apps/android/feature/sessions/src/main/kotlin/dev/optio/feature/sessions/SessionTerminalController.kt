package dev.optio.feature.sessions

import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalState
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlin.time.TimeMark
import kotlin.time.TimeSource
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Owns `/ws/sessions/:id/terminal` and bridges it to a [TerminalState] (port of iOS
 * `SessionTerminalController`). The phone owns this grid (Fit): the PTY is resized to whatever the
 * terminal lays out at, on open and whenever the view's size changes (rotation, the keyboard).
 *
 * Server → client: binary frames are raw PTY bytes; a JSON `{error}` frame is fatal. Client →
 * server: raw bytes for stdin, `{"type":"resize","cols","rows"}` for size.
 *
 * The socket reconnects (a fresh login shell in the worktree) after a drop, like iOS, but not after
 * an `{error}` frame (not active, no pod) and not after [MAX_QUICK_CLOSES] closes in a row that came
 * within [QUICK_CLOSE] of opening with no output (a shell that can't start): [stopped] then turns
 * true and [reconnect] tries again.
 */
class SessionTerminalController(
    val sessionId: String,
    private val api: ApiClient,
    private val scope: CoroutineScope,
    val terminal: TerminalState = TerminalState(),
    private val socketFactory: (ApiClient, String) -> WebSocketClient = { client, path -> client.webSocket(path) },
    private val timeSource: TimeSource = TimeSource.Monotonic,
) {
    private val _connected = MutableStateFlow(false)
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _stopped = MutableStateFlow(false)

    /** Gave up reconnecting; [reconnect] starts over. */
    val stopped: StateFlow<Boolean> = _stopped.asStateFlow()

    private var socket: WebSocketClient? = null
    private var job: Job? = null
    private var fatal = false
    private var quickCloses = 0
    private var openedAt: TimeMark? = null
    private var outputSinceOpen = false

    init {
        terminal.onInput = { bytes -> socket?.send(bytes) }
        terminal.onGridSizeChanged = { grid -> sendResize(grid) }
    }

    /** Connects (no-op while connected or after giving up). */
    fun start() {
        if (job != null || _stopped.value) return
        val ws = socketFactory(api, sessionTerminalPath(sessionId))
        socket = ws
        ws.connect()
        val launched = scope.launch { ws.frames.collect(::handle) }
        job = launched
        launched.invokeOnCompletion {
            if (job === launched) {
                job = null
                socket = null
            }
        }
    }

    /** Disconnects (the screen went away, the session ended). */
    fun stop() {
        job?.cancel()
        job = null
        socket?.disconnect()
        socket = null
        _connected.value = false
    }

    /** Tries again after [stopped] (the Reconnect button). */
    fun reconnect() {
        stop()
        fatal = false
        quickCloses = 0
        _stopped.value = false
        _error.value = null
        start()
    }

    /** Stops for good until [reconnect]. */
    private fun giveUp() {
        socket?.disconnect()
        _stopped.value = true
        _connected.value = false
    }

    /** One frame of the terminal socket (internal for tests). */
    internal fun handle(frame: WsFrame) {
        when (frame) {
            WsFrame.Opened -> {
                _connected.value = true
                _error.value = null
                fatal = false
                openedAt = timeSource.markNow()
                outputSinceOpen = false
                terminal.naturalGrid?.let(::sendResize)
            }
            is WsFrame.Closed -> {
                _connected.value = false
                frame.reason?.takeIf { it.isNotEmpty() }?.let { _error.value = it }
                terminal.feed(DISCONNECTED)
                val quick = !outputSinceOpen && (openedAt?.elapsedNow() ?: Duration.ZERO) < QUICK_CLOSE
                quickCloses = if (quick) quickCloses + 1 else 0
                when {
                    fatal || frame.code in WebSocketClient.CloseCode.permanent -> giveUp()
                    quickCloses >= MAX_QUICK_CLOSES -> {
                        if (_error.value == null) _error.value = "The terminal keeps closing. The session's pod may be gone."
                        giveUp()
                    }
                }
            }
            is WsFrame.Binary -> {
                outputSinceOpen = true
                terminal.feed(frame.bytes)
            }
            is WsFrame.Text -> {
                outputSinceOpen = true
                terminal.feed(frame.text)
            }
            is WsFrame.Json -> {
                val message = frame.value["error"]?.stringValue
                if (message != null) {
                    fatal = true
                    _error.value = message
                    terminal.feed("\r\n\u001b[31m$message\u001b[0m\r\n")
                } else {
                    // Not a control frame we know: show it verbatim (iOS).
                    outputSinceOpen = true
                    terminal.feed(frame.value.toString())
                }
            }
        }
    }

    private fun sendResize(grid: TerminalGrid) {
        val ws = socket ?: return
        if (!_connected.value) return
        ws.send("""{"type":"resize","cols":${grid.cols},"rows":${grid.rows}}""")
    }

    companion object {
        /** What a dropped connection prints (iOS). */
        const val DISCONNECTED = "\r\n[disconnected]\r\n"

        /** A close this soon after opening, with no output, counts toward giving up. */
        val QUICK_CLOSE: Duration = 5.seconds

        const val MAX_QUICK_CLOSES = 3
    }
}
