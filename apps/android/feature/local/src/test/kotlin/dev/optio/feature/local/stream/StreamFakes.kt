package dev.optio.feature.local.stream

import dev.optio.core.network.WsFrame
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import java.io.ByteArrayOutputStream
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.jsonObject

/**
 * A [TerminalSink] that behaves like `TerminalState` where the stream can tell: output is buffered
 * while held, switching to Fit reports the fitted grid through [onGridSizeChanged] (the way the
 * emulator's `fitTo` does), and everything is logged for order assertions.
 */
class FakeSink(natural: TerminalGrid? = TerminalGrid(50, 20)) : TerminalSink {
    val log = mutableListOf<String>()
    private val painted = ByteArrayOutputStream()
    private val held = ByteArrayOutputStream()
    var holding = false
        private set
    var releases = mutableListOf<Boolean>()
    var resets = 0
        private set

    /** The terminal's `onGridSizeChanged`, as the ViewModel wires it to the stream. */
    var onGridSizeChanged: ((TerminalGrid) -> Unit)? = null
    private var reported: TerminalGrid? = null

    var natural: TerminalGrid? = natural
        set(value) {
            field = value
            // A new fit re-lays out a Fit terminal (and reports it), like TerminalState.onViewLaidOut.
            if (value != null && gridMode == TerminalGridMode.Fit) report(value)
        }

    override val naturalGrid: TerminalGrid? get() = natural

    override val grid: TerminalGrid
        get() =
            when (val m = gridMode) {
                is TerminalGridMode.Fixed -> m.grid
                TerminalGridMode.Fit -> natural ?: TerminalGrid(80, 24)
            }

    override var gridMode: TerminalGridMode = TerminalGridMode.Fit
        set(value) {
            if (field == value) return
            field = value
            log += "mode:$value"
            if (value == TerminalGridMode.Fit) natural?.let(::report)
        }

    private fun report(grid: TerminalGrid) {
        if (grid == reported) return
        reported = grid
        onGridSizeChanged?.invoke(grid)
    }

    override fun hold() {
        holding = true
        log += "hold"
    }

    override fun release(suppressReplies: Boolean) {
        log += "release(suppress=$suppressReplies)"
        releases += suppressReplies
        holding = false
        painted.write(held.toByteArray())
        held.reset()
    }

    override fun feed(bytes: ByteArray) {
        if (holding) held.write(bytes) else painted.write(bytes)
    }

    override fun reset() {
        resets++
        log += "reset"
        painted.reset()
        held.reset()
    }

    /** What reached the screen (not what is still held). */
    fun painted(): String = painted.toString(Charsets.UTF_8)

    fun heldText(): String = held.toString(Charsets.UTF_8)
}

/** A scripted connection: frames are pushed by the test; sends are recorded. */
class FakeStreamSocket : StreamSocket {
    private val channel = Channel<WsFrame>(Channel.UNLIMITED)
    override val frames: Flow<WsFrame> = channel.receiveAsFlow()
    val sent = mutableListOf<String>()
    var connected = false
        private set
    var disconnected = false
        private set

    override fun connect() {
        connected = true
    }

    override fun disconnect() {
        disconnected = true
        channel.close()
    }

    override fun send(text: String): Boolean {
        if (disconnected) return false
        sent += text
        return true
    }

    fun emit(frame: WsFrame) {
        channel.trySend(frame)
    }

    fun opened() = emit(WsFrame.Opened)

    fun json(text: String) = emit(WsFrame.Json(Json.parseToJsonElement(text).jsonObject))

    fun bytes(text: String) = emit(WsFrame.Binary(text.toByteArray()))

    fun closed(code: Int) {
        emit(WsFrame.Closed(code, null))
        channel.close()
    }

    fun status(state: String, attention: String = "working") = json("""{"type":"status","state":"$state","attentionState":"$attention"}""")

    fun size(cols: Int, rows: Int) = json("""{"type":"size","cols":$cols,"rows":$rows}""")

    /** The resize frames sent, as grids. */
    fun resizes(): List<TerminalGrid> =
        sent.mapNotNull { text ->
            val o = Json.parseToJsonElement(text).jsonObject
            if (o["type"].toString().trim('"') != "resize") return@mapNotNull null
            TerminalGrid(o["cols"].toString().toInt(), o["rows"].toString().toInt())
        }

    /** The input frames sent, as their data strings. */
    fun inputs(): List<String> =
        sent.mapNotNull { text ->
            val o = Json.parseToJsonElement(text).jsonObject
            if (o["type"].toString().trim('"') != "input") return@mapNotNull null
            Json.decodeFromString<String>(o["data"].toString())
        }
}
