package dev.optio.feature.local.stream

import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import dev.optio.core.terminal.TerminalState
import kotlinx.coroutines.flow.Flow

/**
 * One connection to `/ws/local/terminals/:id/stream`, as [LocalTerminalStream] uses it. In the app
 * a [WebSocketClient] without auto-reconnect ([StreamPolicy][dev.optio.core.terminal.StreamPolicy]
 * decides about reconnects); tests pass a scripted fake.
 */
interface StreamSocket {
    /** Every frame of this connection, in order, for one collector. Completes after [disconnect]. */
    val frames: Flow<WsFrame>

    fun connect()

    /** Closes for good: no [WsFrame.Closed] follows. */
    fun disconnect()

    /** A JSON text frame; false while not connected. */
    fun send(text: String): Boolean
}

/** [StreamSocket] over core:network's [WebSocketClient] (ws-token auth, the 300 ms send hold). */
class WebSocketStreamSocket(private val client: WebSocketClient) : StreamSocket {
    override val frames: Flow<WsFrame> get() = client.frames

    override fun connect() = client.connect()

    override fun disconnect() = client.disconnect()

    override fun send(text: String): Boolean = client.send(text)

    companion object {
        /** The stream socket of [terminalId] on [api]'s server. */
        fun open(
            api: ApiClient,
            terminalId: String,
        ): StreamSocket = WebSocketStreamSocket(WebSocketClient(api, "/ws/local/terminals/$terminalId/stream", autoReconnect = false))
    }
}

/**
 * Where the stream's terminal bytes go, and what it needs to know about the screen showing them.
 * The app's sink is [TerminalStateSink] (the Screen face's emulator); tests record into a fake.
 * Every call happens on the main thread.
 */
interface TerminalSink {
    /** The grid the emulator lays out at now (what a claim sends the PTY). */
    val grid: TerminalGrid

    /** What a fit to the on-screen view produces at the base font; null until a view has laid out. */
    val naturalGrid: TerminalGrid?

    /** Fit to the view (unclaimed / owner) or render someone else's grid scaled to fit (passive). */
    var gridMode: TerminalGridMode

    /** Buffer output until [release]: a connection's scrollback replay waits for its `size` frame. */
    fun hold()

    /**
     * Plays the held output. [suppressReplies] drops the emulator's answers to queries inside it (a
     * replayed `ESC [ c` must not answer a program that asked long ago).
     */
    fun release(suppressReplies: Boolean = false)

    fun feed(bytes: ByteArray)

    fun feed(text: String) = feed(text.toByteArray(Charsets.UTF_8))

    /** Back to a blank screen (the first bytes of a reconnect's replay). */
    fun reset()
}

/** [TerminalSink] over `:core:terminal`'s [TerminalState]: the stream owns the hold timeout. */
class TerminalStateSink(val state: TerminalState) : TerminalSink {
    override val grid: TerminalGrid get() = state.grid
    override val naturalGrid: TerminalGrid? get() = state.naturalGrid
    override var gridMode: TerminalGridMode
        get() = state.gridMode
        set(value) {
            state.gridMode = value
        }

    override fun hold() = state.hold(timeoutMillis = 0)

    override fun release(suppressReplies: Boolean) = state.release(suppressReplies)

    override fun feed(bytes: ByteArray) = state.feed(bytes)

    override fun feed(text: String) = state.feed(text)

    override fun reset() = state.reset()
}
