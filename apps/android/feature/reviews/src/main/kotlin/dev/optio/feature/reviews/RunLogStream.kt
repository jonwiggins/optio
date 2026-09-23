package dev.optio.feature.reviews

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.ui.log.TaskLogRow
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.abs
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * The historical + live log feed of a PR review or job run (iOS `RunLogStream`, web
 * `usePrReviewLogs` / `useWorkflowRunLogs`):
 *
 * 1. opens the WebSocket first, so nothing that happens while history loads is lost (the server's
 *    `catchUp: true` replay is skipped: REST history is canonical);
 * 2. backfills history over REST ([start]'s `history`);
 * 3. buffers live frames until history has merged, then drops the ones history already has
 *    ([LogMerge.merge]); later frames append, skipping an exact repeat of the last line;
 * 4. after the socket reconnects (the client retries every 3 s), re-reads history to fill the gap
 *    ([LogMerge.reload]); the owner calls [reloadHistory] too when a new run starts.
 *
 * Frames whose type is in `stateEventTypes` are forwarded on [stateChanges] so the screen can
 * refetch. Everything runs on [scope] (a ViewModel's, i.e. Main): no locking needed. [stop] (or
 * the scope ending) closes the socket.
 */
internal class RunLogStream(
    private val scope: CoroutineScope,
    private val logEventType: String,
    private val stateEventTypes: Set<String>,
    private val openSocket: (path: String) -> WebSocketClient,
) {
    private val _entries = MutableStateFlow<List<AgentLogEntry>>(emptyList())

    /** The transcript: history, then live lines. */
    val entries: StateFlow<List<AgentLogEntry>> = _entries.asStateFlow()

    private val _connected = MutableStateFlow(false)

    /** True while the socket is open. */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)

    /** Why the last history load failed; null once one succeeds. */
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private val _stateChanges = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** The type of every state-change frame (`pr_review:state_changed`, …). */
    val stateChanges: SharedFlow<String> = _stateChanges.asSharedFlow()

    private var socket: WebSocketClient? = null
    private var pump: Job? = null
    private var historyJob: Job? = null
    private var pending = mutableListOf<AgentLogEntry>()
    private var merged = false
    private var opens = 0
    private var history: (suspend () -> List<AgentLogEntry>)? = null

    /** True between [start] and [stop]. */
    val isStarted: Boolean
        get() = history != null

    /** (Re)starts the feed: the socket at [wsPath] (none when null), then [history]. */
    fun start(wsPath: String?, history: suspend () -> List<AgentLogEntry>) {
        stop()
        this.history = history
        merged = false
        pending = mutableListOf()
        opens = 0
        if (wsPath != null) {
            val ws = openSocket(wsPath)
            socket = ws
            ws.connect()
            pump = scope.launch { ws.frames.collect(::handle) }
        }
        historyJob = scope.launch {
            try {
                val rows = history()
                _entries.value = LogMerge.merge(rows, pending)
                _error.value = null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e
                _entries.value = pending.toList()
            }
            pending = mutableListOf()
            merged = true
        }
    }

    /** Re-reads history without dropping the socket (a new run started, or the socket reconnected). */
    fun reloadHistory() {
        val history = history ?: return
        scope.launch {
            val rows = try {
                history()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                return@launch
            }
            _entries.value = LogMerge.reload(rows, _entries.value)
            _error.value = null
        }
    }

    /** Closes the socket and stops loading; [entries] stay as they are. */
    fun stop() {
        pump?.cancel()
        pump = null
        historyJob?.cancel()
        historyJob = null
        socket?.disconnect()
        socket = null
        history = null
        _connected.value = false
    }

    private fun handle(frame: WsFrame) {
        when (frame) {
            WsFrame.Opened -> {
                _connected.value = true
                // A reconnect: whatever was logged while the socket was down is only in history.
                if (opens++ > 0 && merged) reloadHistory()
            }
            is WsFrame.Closed -> _connected.value = false
            is WsFrame.Json -> handleJson(frame.value)
            is WsFrame.Text, is WsFrame.Binary -> Unit
        }
    }

    private fun handleJson(obj: JsonObject) {
        val type = obj["type"]?.stringValue ?: return
        if (type in stateEventTypes) {
            _stateChanges.tryEmit(type)
            return
        }
        if (type != logEventType || obj["catchUp"]?.boolValue == true) return
        val content = obj["content"]?.stringValue ?: return
        val entry = AgentLogEntry(
            taskId = "",
            timestamp = ReviewDates.normalize(obj["timestamp"]?.stringValue),
            type = AgentLogEntry.TypeValue.fromRaw(obj["logType"]?.stringValue ?: "text"),
            content = content,
            metadata = obj["metadata"] as? JsonObject,
        )
        if (!merged) {
            pending += entry
            return
        }
        val last = _entries.value.lastOrNull()
        if (last != null && last.content == entry.content && last.type == entry.type && last.timestamp == entry.timestamp) return
        _entries.value = _entries.value + entry
    }
}

/**
 * How history and live lines combine. A line's REST row and its live frame carry slightly
 * different timestamps (the row is stamped by Postgres on insert, the frame by the worker right
 * after), so "the same line" means same type and content within [MATCH_WINDOW_MS]; each history row
 * absorbs at most one live line, so a line that really repeats is kept.
 */
internal object LogMerge {
    const val MATCH_WINDOW_MS = 5_000L

    fun sameLine(a: AgentLogEntry, b: AgentLogEntry): Boolean {
        if (a.type != b.type || a.content != b.content) return false
        val ta = ReviewDates.parse(a.timestamp)
        val tb = ReviewDates.parse(b.timestamp)
        if (ta == null || tb == null) return a.timestamp == b.timestamp
        return abs(ta.toEpochMilli() - tb.toEpochMilli()) <= MATCH_WINDOW_MS
    }

    /** [history] then the [live] lines it does not already contain, in arrival order. */
    fun merge(history: List<AgentLogEntry>, live: List<AgentLogEntry>): List<AgentLogEntry> =
        history + unmatched(history, live)

    /**
     * A fresh [history] (latest run) plus the lines on screen it does not contain and that are newer
     * than its last line: live lines not persisted yet survive, an older run's lines drop out.
     */
    fun reload(history: List<AgentLogEntry>, current: List<AgentLogEntry>): List<AgentLogEntry> {
        val last = history.lastOrNull()?.timestamp.orEmpty()
        return history + unmatched(history, current).filter { it.timestamp > last }
    }

    private fun unmatched(history: List<AgentLogEntry>, lines: List<AgentLogEntry>): List<AgentLogEntry> {
        val pool = history.toMutableList()
        return lines.filter { line ->
            val index = pool.indexOfFirst { sameLine(it, line) }
            if (index >= 0) {
                pool.removeAt(index)
                false
            } else {
                true
            }
        }
    }
}

/** A stored log row as a transcript entry (iOS `RunLogRow.asEntry`): unknown log types stay unknown. */
internal fun TaskLogRow.toLogEntry(): AgentLogEntry = AgentLogEntry(
    taskId = "",
    timestamp = ReviewDates.normalize(timestamp),
    type = AgentLogEntry.TypeValue.fromRaw(logType ?: "text"),
    content = content,
    metadata = metadata,
)
