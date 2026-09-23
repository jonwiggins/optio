package dev.optio.feature.tasks.logs

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.boolValue
import dev.optio.core.model.objectValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.ui.log.TaskLogRow
import dev.optio.feature.tasks.data.HISTORICAL_LOG_LIMIT
import dev.optio.feature.tasks.data.jobRunLogs
import dev.optio.feature.tasks.data.taskLogs
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonObject

/**
 * A log you can watch: stored rows over REST, then live frames over a WebSocket, merged without
 * duplicates ([LogBook]). Mirrors iOS `TaskLogStream` / `RunLogStream` and the web's `useLogs` /
 * `useWorkflowRunLogs`, and goes further where they lose lines:
 *
 * - The socket's catch-up replay (`catchUp: true`) is ignored; REST is canonical. Live frames that
 *   arrive before the first history lands are held back and merged, not shown twice.
 * - Every (re)open of the socket after the first — an automatic reconnect, or [start] after
 *   [stop] when the screen comes back — backfills from REST, so nothing printed while it was
 *   down goes missing.
 * - With [upgradeUntyped], a live frame without a `logType` (task logs: the server doesn't send
 *   one) schedules a quick tail fetch that swaps it for its typed stored row, so tool calls render
 *   as tool calls a moment later instead of as raw text.
 *
 * Owned by one screen's ViewModel: call [start] when the screen shows and [stop] when it leaves
 * (the socket closes; the lines stay). All calls must happen on [scope]'s thread (Main).
 */
open class LogStream(
    private val scope: CoroutineScope,
    private val ownerId: String,
    private val wsPath: String,
    private val logEventType: String,
    private val stateEventTypes: Set<String>,
    private val socketFactory: (path: String) -> WebSocketClient,
    /** Stored rows from an offset (a store that can't page may ignore it and return them all). */
    private val history: suspend (offset: Int) -> List<TaskLogRow>,
    private val upgradeUntyped: Boolean = false,
    private val upgradeDelay: Duration = UPGRADE_DELAY,
    /**
     * When [history] pages by offset: a full page means more rows follow (the route returns the
     * oldest rows first), so the stream keeps fetching until a page comes back short.
     */
    private val pageSize: Int? = null,
) {
    private val book = LogBook(ownerId)
    private val fetchLock = Mutex()

    private val _entries = MutableStateFlow<List<AgentLogEntry>>(emptyList())

    /** The merged log, oldest first. Empty until the first history load settles. */
    val entries: StateFlow<List<AgentLogEntry>> = _entries.asStateFlow()

    private val _connected = MutableStateFlow(false)

    /** True while the socket is open. */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _loaded = MutableStateFlow(false)

    /** True once the first history load finished (or failed). */
    val loaded: StateFlow<Boolean> = _loaded.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)

    /** Why the first history load failed (null when it worked). */
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private val _stateChanges = MutableSharedFlow<String>(extraBufferCapacity = 16)

    /** Frame types that mean the owner changed ([stateEventTypes]): refetch it. */
    val stateChanges: SharedFlow<String> = _stateChanges.asSharedFlow()

    private var socket: WebSocketClient? = null
    private var pump: Job? = null
    private var upgradeJob: Job? = null
    private var historyLoaded = false

    /** Bumped by [reload]: a fetch that started before it is dropped. */
    private var generation = 0

    /** True between [start] and [stop]. */
    val isStarted: Boolean
        get() = socket != null

    /** Opens the socket and loads history (the first time) or what's new since (after that). */
    fun start() {
        if (socket != null) return
        val ws = socketFactory(wsPath)
        socket = ws
        ws.connect()
        pump = scope.launch {
            var opens = 0
            ws.frames.collect { frame ->
                when (frame) {
                    WsFrame.Opened -> {
                        _connected.value = true
                        // The first open races the initial fetch below; later ones follow a gap.
                        if (++opens > 1) backfill()
                    }
                    is WsFrame.Closed -> _connected.value = false
                    is WsFrame.Json -> handle(frame.value)
                    else -> Unit
                }
            }
        }
        backfill()
    }

    /** Closes the socket; the lines stay and [start] picks up where this left off. */
    fun stop() {
        upgradeJob?.cancel()
        upgradeJob = null
        pump?.cancel()
        pump = null
        socket?.disconnect()
        socket = null
        _connected.value = false
    }

    /** Forgets every line and loads the log again (a force redo deleted it on the server). */
    fun reload() {
        generation++
        book.clear()
        historyLoaded = false
        _loaded.value = false
        _entries.value = emptyList()
        backfill()
    }

    /** Shows a message the user just sent, as a "You" line (it isn't in the server's log). */
    fun appendLocal(text: String, interrupt: Boolean, now: Instant = Instant.now()) {
        book.addLocal(localEntry(ownerId, text, interrupt, now))
        publish()
    }

    /** Fetches what's new (the whole log the first time) and merges it. */
    fun backfill(): Job = scope.launch { fetchLocked() }

    private suspend fun fetchLocked() = fetchLock.withLock {
        val gen = generation
        try {
            var pages = 0
            while (true) {
                val rows = history(book.storedCount)
                if (gen != generation) return@withLock
                book.addStored(rows)
                _error.value = null
                // A long log comes in pages from the oldest row; show the first page right away.
                if (pageSize == null || rows.size < pageSize || ++pages >= MAX_PAGES) break
                historyLoaded = true
                _loaded.value = true
                publish()
            }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!historyLoaded) _error.value = e
        }
        historyLoaded = true
        _loaded.value = true
        publish()
    }

    private fun handle(obj: JsonObject) {
        val type = obj["type"]?.stringValue ?: return
        if (type in stateEventTypes) {
            _stateChanges.tryEmit(type)
            // The run just finished or moved on: its last rows are worth having typed.
            if (upgradeUntyped && book.hasPendingLive) scheduleUpgrade()
            return
        }
        if (type != logEventType) return
        if (obj["catchUp"]?.boolValue == true) return
        val content = obj["content"]?.stringValue ?: return
        val logType = obj["logType"]?.stringValue
        val entry = AgentLogEntry(
            taskId = ownerId,
            timestamp = obj["timestamp"]?.stringValue.orEmpty(),
            type = AgentLogEntry.TypeValue.fromRawOrNull(logType ?: "text") ?: AgentLogEntry.TypeValue.TEXT,
            content = content,
            metadata = obj["metadata"]?.objectValue,
        )
        if (book.addLive(entry)) {
            publish()
            if (upgradeUntyped && logType == null) scheduleUpgrade()
        }
    }

    /** At most one pending tail fetch: the first untyped frame starts the clock. */
    private fun scheduleUpgrade() {
        if (upgradeJob?.isActive == true) return
        upgradeJob = scope.launch {
            delay(upgradeDelay)
            fetchLocked()
        }
    }

    private fun publish() {
        if (historyLoaded) _entries.value = book.entries
    }

    /** Test hook: where each line on screen came from. */
    internal fun origins(): List<LogBook.Origin> = book.origins()

    companion object {
        /** How long an untyped live frame waits for its typed row. */
        val UPGRADE_DELAY: Duration = 1_500.milliseconds

        /** At most this many pages per fetch (a runaway log shouldn't pin the screen). */
        const val MAX_PAGES = 20

        /** The "You" line for a sent message (rendered as a prompt card by `AgentLogRow`). */
        fun localEntry(ownerId: String, text: String, interrupt: Boolean, now: Instant): AgentLogEntry = AgentLogEntry(
            taskId = ownerId,
            timestamp = now.toString(),
            type = AgentLogEntry.TypeValue.TEXT,
            content = if (interrupt) "[interrupt] $text" else text,
            metadata = mapOf("role" to kotlinx.serialization.json.JsonPrimitive("user")),
        )
    }
}

/**
 * A Repo Task's log: `GET /api/tasks/:id/logs` (paged by offset) + `/ws/logs/:taskId`. Live
 * `task:log` frames carry no type, so they're upgraded from REST shortly after they arrive.
 * [stateChanges] fires on `task:state_changed`, `task:stalled`, `task:recovered` and message
 * delivery / ack.
 */
class TaskLogStream(
    api: ApiClient,
    taskId: String,
    scope: CoroutineScope,
    socketFactory: (path: String) -> WebSocketClient = { api.webSocket(it) },
    upgradeDelay: Duration = LogStream.UPGRADE_DELAY,
    pageSize: Int = HISTORICAL_LOG_LIMIT,
) : LogStream(
    scope = scope,
    ownerId = taskId,
    wsPath = "/ws/logs/$taskId",
    logEventType = "task:log",
    stateEventTypes = setOf("task:state_changed", "task:stalled", "task:recovered", "task:message_delivered", "task:message_acked"),
    socketFactory = socketFactory,
    history = { offset -> api.taskLogs(taskId, offset = offset, limit = pageSize) },
    upgradeUntyped = true,
    upgradeDelay = upgradeDelay,
    pageSize = pageSize,
)

/**
 * A Job run's log: `GET /api/workflow-runs/:id/logs` (the whole log; rows are deduplicated by id)
 * + `/ws/workflow-runs/:id/logs`. Live frames are typed. [stateChanges] fires on
 * `workflow_run:state_changed`.
 */
class RunLogStream(
    api: ApiClient,
    runId: String,
    scope: CoroutineScope,
    socketFactory: (path: String) -> WebSocketClient = { api.webSocket(it) },
) : LogStream(
    scope = scope,
    ownerId = runId,
    wsPath = "/ws/workflow-runs/$runId/logs",
    logEventType = "workflow_run:log",
    stateEventTypes = setOf("workflow_run:state_changed"),
    socketFactory = socketFactory,
    history = { _ -> api.jobRunLogs(runId) },
)
