package dev.optio.feature.local.stream

import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalStreamServerMessage
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.OptioJson
import dev.optio.core.network.WsFrame
import dev.optio.core.terminal.StreamPolicy
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalSizing
import dev.optio.core.terminal.gridMode
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/**
 * Viewer for `/ws/local/terminals/:id/stream`: a port of iOS `LocalTerminalStream` (web
 * `local-terminal.tsx` + `stream-policy.ts` + `sizing.ts`), driving a [TerminalSink].
 *
 * - Server → client: binary frames are raw terminal bytes (the scrollback replay, then live); JSON
 *   frames are control: `status` / `size` / `exit` / `error`.
 * - Client → server: JSON only, `{type:"input", data}` and `{type:"resize", cols, rows}`.
 *
 * One PTY, one grid. Attaching never resizes it; only an explicit interaction (a tap or focus on the
 * terminal, a key-bar key, "Use this screen": [claim]) takes the grid for this phone. Until then the
 * sink renders the daemon's announced grid shrunk to fit ([State.foreignGrid], "Sized for another
 * device"). Each connection's replay is held until its `size` frame lands (or [sizeHold] passes), so
 * it paints at the grid it was drawn for: a TUI's absolute cursor moves can't be reflowed later.
 *
 * Runs on the main thread ([scope] = the ViewModel's scope). Wire the terminal's callbacks to
 * [sendInput], [onInteraction], [onGridSizeChanged] and [onNaturalGridChanged]. A stream is spent
 * after [disconnect]; a screen that comes back creates a new one over the same sink, and the first
 * bytes of its replay reset the screen.
 */
class LocalTerminalStream(
    val terminalId: String,
    private val scope: CoroutineScope,
    private val sink: TerminalSink,
    private val openSocket: () -> StreamSocket,
    private val reconnectDelay: Duration = RECONNECT_DELAY,
    private val sizeHold: Duration = SIZE_HOLD,
) {
    enum class ConnState(val label: String) {
        CONNECTING("connecting…"),
        CONNECTED("connected"),
        RECONNECTING("reconnecting…"),
        DISCONNECTED("disconnected"),
    }

    /** What the Screen face and the header read. */
    data class State(
        val conn: ConnState = ConnState.CONNECTING,
        /** From the last `status` frame. */
        val terminalState: LocalTerminalState? = null,
        val attentionState: LocalAttentionState? = null,
        val exitCode: Int? = null,
        /** The last `error` frame ("Host is offline") or a permanent close's message. */
        val errorMessage: String? = null,
        /** The error is being retried (the host is offline) rather than final. */
        val retrying: Boolean = false,
        /** Terminal bytes have arrived: the screen holds real output. */
        val outputSeen: Boolean = false,
        /** The stream has said all it will (an exit frame, or a final close). */
        val settled: Boolean = false,
        val mode: TerminalSizing.Mode = TerminalSizing.Mode.Unclaimed,
        /** The terminal has exited: [foreignGrid] is the grid its final screen was recorded at, pinned. */
        val recorded: Boolean = false,
        /** Exited or errored: nothing more streams, nothing can be typed. */
        val dead: Boolean = false,
    ) {
        /** Someone else's grid (or the recorded one) rendered scaled to fit: drives the strip. */
        val foreignGrid: TerminalGrid? get() = (mode as? TerminalSizing.Mode.Passive)?.grid

        val ownsGrid: Boolean get() = mode == TerminalSizing.Mode.Owner

        val connected: Boolean get() = conn == ConnState.CONNECTED
    }

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** A `status` frame: the terminal's lifecycle and attention, pushed while attached. */
    var onStatus: ((LocalTerminalState, LocalAttentionState) -> Unit)? = null

    /** An `exit` frame (after any recorded screen). */
    var onExit: ((Int?) -> Unit)? = null

    private var socket: StreamSocket? = null
    private var readJob: Job? = null
    private var reconnectJob: Job? = null
    private var holdJob: Job? = null
    private var holding = false
    private var disposed = false

    /** Reset the screen on the next connection's first bytes (its replay repaints everything). */
    private var pendingReset = true
    private var liveOnThisConnection = false
    private var terminalDead = false

    private var mode: TerminalSizing.Mode = TerminalSizing.Mode.Unclaimed

    /** Grids we've asked for and not yet heard echoed, oldest first. */
    private var sent: List<TerminalGrid> = emptyList()

    /** The PTY grid the daemon last announced. */
    private var announced: TerminalGrid? = null

    val isDisposed: Boolean get() = disposed

    // region Connection

    fun connect() {
        if (disposed) return
        readJob?.cancel()
        readJob = null
        socket?.disconnect()
        val s = openSocket()
        socket = s
        liveOnThisConnection = false
        beginHold()
        if (_state.value.conn != ConnState.RECONNECTING) _state.update { it.copy(conn = ConnState.CONNECTING) }
        s.connect()
        readJob =
            scope.launch {
                s.frames.collect { frame -> if (socket === s) handle(frame, s) }
            }
    }

    /** User-initiated: drop the socket and connect again (also clears a dead flag, so a restarted terminal re-attaches). */
    fun reconnect() {
        if (disposed) return
        terminalDead = false
        pendingReset = true
        reconnectJob?.cancel()
        _state.update { it.copy(errorMessage = null, retrying = false, conn = ConnState.RECONNECTING, dead = false, settled = false) }
        connect()
    }

    /** For good (the screen went away): closes the socket and lets any held output play. */
    fun disconnect() {
        if (disposed) return
        disposed = true
        reconnectJob?.cancel()
        holdJob?.cancel()
        readJob?.cancel()
        socket?.disconnect()
        socket = null
        if (holding) {
            holding = false
            sink.release()
        }
    }

    // endregion

    // region Server → client

    private fun handle(
        frame: WsFrame,
        from: StreamSocket,
    ) {
        when (frame) {
            WsFrame.Opened -> {
                _state.update { it.copy(conn = ConnState.CONNECTED) }
                // Attaching never resizes the PTY. If we already own it (a reconnect after a blip),
                // re-assert our grid; otherwise wait for `size`.
                if (mode == TerminalSizing.Mode.Owner) sendResize(sink.grid)
            }
            is WsFrame.Binary -> onBytes(frame.bytes)
            // Non-JSON text is unexpected on this stream; render it so nothing is lost.
            is WsFrame.Text -> sink.feed(frame.text)
            is WsFrame.Json -> onControl(frame.value, from)
            is WsFrame.Closed -> onClosed(frame.code)
        }
    }

    private fun onBytes(bytes: ByteArray) {
        if (pendingReset) {
            pendingReset = false
            sink.reset()
        }
        val s = _state.value
        if (!s.outputSeen || (s.errorMessage != null && s.retrying)) {
            _state.update {
                it.copy(
                    outputSeen = true,
                    errorMessage = if (it.retrying) null else it.errorMessage,
                    retrying = false,
                )
            }
        }
        sink.feed(bytes)
    }

    private fun onControl(
        json: JsonObject,
        from: StreamSocket,
    ) {
        val message =
            try {
                OptioJson.decodeFromJsonElement(LocalStreamServerMessage.serializer(), json)
            } catch (_: Exception) {
                return
            }
        when (message) {
            is LocalStreamServerMessage.Status -> {
                if (StreamPolicy.isTerminalStateDead(message.state.raw)) terminalDead = true else liveOnThisConnection = true
                _state.update { it.copy(terminalState = message.state, attentionState = message.attentionState, dead = terminalDead) }
                onStatus?.invoke(message.state, message.attentionState)
            }
            is LocalStreamServerMessage.Size -> {
                val grid = TerminalGrid(message.cols.toInt(), message.rows.toInt())
                if (grid.cols > 0 && grid.rows > 0) gridAnnounced(grid)
                // Everything before this frame was the replay: don't answer its queries.
                releaseHold(suppressReplies = true)
            }
            is LocalStreamServerMessage.Exit -> {
                terminalDead = true
                releaseHold()
                val code = message.exitCode?.toInt()
                _state.update { it.copy(dead = true, settled = true, exitCode = code) }
                sink.feed("\r\n\u001b[2m[process exited${code?.let { " (code $it)" } ?: ""}]\u001b[0m\r\n")
                onExit?.invoke(code)
            }
            is LocalStreamServerMessage.Error -> {
                releaseHold()
                // An error on a live terminal ("Host is offline") leaves the socket attached to
                // nothing: close it and retry until the daemon is back.
                if (liveOnThisConnection && !terminalDead) {
                    _state.update { it.copy(errorMessage = message.message, retrying = true) }
                    from.disconnect() // completes its frames; no Closed follows
                    if (socket === from) socket = null
                    scheduleReconnect()
                } else {
                    _state.update { it.copy(errorMessage = message.message, retrying = false) }
                }
            }
            is LocalStreamServerMessage.Unknown -> Unit
        }
    }

    private fun onClosed(code: Int) {
        if (disposed) return
        releaseHold()
        socket = null
        when (val action = StreamPolicy.closeAction(code, terminalDead = terminalDead, retryRequested = false)) {
            // Stopping means nothing retries any more; a permanent close replaces the message.
            is StreamPolicy.CloseAction.Stop ->
                _state.update {
                    it.copy(
                        conn = ConnState.DISCONNECTED,
                        settled = true,
                        errorMessage = action.message ?: it.errorMessage,
                        retrying = false,
                    )
                }
            StreamPolicy.CloseAction.Reconnect -> scheduleReconnect()
        }
    }

    private fun scheduleReconnect() {
        if (disposed) return
        _state.update { it.copy(conn = ConnState.RECONNECTING) }
        pendingReset = true
        reconnectJob?.cancel()
        reconnectJob =
            scope.launch {
                delay(reconnectDelay)
                if (!disposed) connect()
            }
    }

    private fun beginHold() {
        holdJob?.cancel()
        if (!holding) {
            holding = true
            sink.hold()
        }
        holdJob =
            scope.launch {
                delay(sizeHold)
                releaseHold()
            }
    }

    private fun releaseHold(suppressReplies: Boolean = false) {
        holdJob?.cancel()
        holdJob = null
        if (!holding) return
        holding = false
        sink.release(suppressReplies)
    }

    // endregion

    // region Grid ownership

    private fun gridAnnounced(grid: TerminalGrid) {
        announced = grid
        val natural = sink.naturalGrid ?: TerminalGrid(0, 0)
        val next =
            if (mode == TerminalSizing.Mode.Owner && !terminalDead && grid == sink.grid) {
                // Our own grid, re-announced because another viewer attached: still ours. (The
                // shared rule would demote us to "Sized for another device" at our own size.)
                TerminalSizing.Mode.Owner
            } else {
                TerminalSizing.onGridAnnounced(mode, grid, natural, sent, recorded = terminalDead)
            }
        TerminalSizing.ackSentGrid(sent, grid)?.let { sent = it }
        setMode(next, recorded = terminalDead)
    }

    private fun setMode(
        next: TerminalSizing.Mode,
        recorded: Boolean = _state.value.recorded,
    ) {
        mode = next
        _state.update { it.copy(mode = next, recorded = recorded) }
        // Last: switching to Fit refits at once and reports the grid (→ onGridSizeChanged).
        sink.gridMode = next.gridMode
    }

    /**
     * This screen is being used: size the PTY to it. Nothing is left to size once the process is
     * gone, and a tap to select text must not reflow a replayed screen out of its recorded grid.
     */
    fun claim() {
        if (terminalDead || disposed) return
        val before = sent.size
        setMode(TerminalSizing.Mode.Owner)
        // Always tell the daemon, even if our grid is what we last sent: another viewer may have
        // resized the PTY in between. (The switch to Fit may already have sent it.)
        if (sent.size == before && sink.naturalGrid != null) sendResize(sink.grid)
    }

    /** The terminal saw an explicit interaction (tap, focus, a key): claim first, so the program lays out for us. */
    fun onInteraction() {
        if (mode != TerminalSizing.Mode.Owner) claim()
    }

    /** The terminal's own grid changed (rotation, keyboard, our claim). Only the owner tells the PTY. */
    fun onGridSizeChanged(grid: TerminalGrid) {
        if (mode == TerminalSizing.Mode.Owner) sendResize(grid)
    }

    /**
     * Our fit changed (first layout, rotation, the keyboard, the strip coming or going). Unclaimed or
     * passive: judge the PTY's grid again against it (a grid announced while the Screen face was
     * hidden was judged without knowing our fit). The owner never does: the last announcement
     * predates its own resizes, and judging it would demote the phone, whose strip would then change
     * the fit again.
     */
    fun onNaturalGridChanged() {
        if (mode == TerminalSizing.Mode.Owner) return
        announced?.let(::gridAnnounced)
    }

    // endregion

    // region Client → server

    /** Writes [text] to the PTY (keys, the composer's message + Enter). False while it can't. */
    fun sendInput(text: String): Boolean {
        if (text.isEmpty() || !_state.value.connected || terminalDead) return false
        return socket?.send(inputFrame(text)) ?: false
    }

    fun sendInput(bytes: ByteArray): Boolean = sendInput(String(bytes, Charsets.UTF_8))

    private fun sendResize(grid: TerminalGrid) {
        if (grid.cols <= 0 || grid.rows <= 0) return
        sent = TerminalSizing.pushSentGrid(sent, grid)
        if (!_state.value.connected) return
        socket?.send(resizeFrame(grid))
    }

    // endregion

    companion object {
        /** Delay before an automatic reconnect (web and iOS: 2 s). */
        val RECONNECT_DELAY: Duration = 2.seconds

        /** How long a replay waits for the daemon's `size` frame before it plays anyway (iOS: 1.5 s). */
        val SIZE_HOLD: Duration = 1500.milliseconds

        /** `{"type":"input","data":…}`: the one input frame (no raw keystroke frames). */
        fun inputFrame(text: String): String =
            buildJsonObject {
                put("type", "input")
                put("data", text)
            }.toString()

        /** `{"type":"resize","cols":…,"rows":…}` with integer dimensions (the server checks `Number.isInteger`). */
        fun resizeFrame(grid: TerminalGrid): String =
            buildJsonObject {
                put("type", "resize")
                put("cols", grid.cols)
                put("rows", grid.rows)
            }.toString()
    }
}
