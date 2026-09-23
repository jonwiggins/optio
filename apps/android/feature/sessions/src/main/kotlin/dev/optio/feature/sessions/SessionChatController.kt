package dev.optio.feature.sessions

import androidx.compose.runtime.Immutable
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.OptioJson
import dev.optio.core.model.SessionChatClientMessage
import dev.optio.core.model.SessionChatServerMessage
import dev.optio.core.model.SessionChatStatus
import dev.optio.core.model.boolValue
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.ui.state.ErrorText
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** One line of the session chat: a prompt you typed, or an agent event. */
@Immutable
sealed interface SessionChatRow {
    val id: String

    data class User(override val id: String, val text: String) : SessionChatRow

    data class Entry(override val id: String, val entry: AgentLogEntry) : SessionChatRow
}

/** Where the chat socket is (iOS `SessionChatModel.ConnectionStatus`). */
enum class SessionChatConnection(val label: String) {
    CONNECTING("connecting"),
    READY("ready"),
    THINKING("thinking"),
    IDLE("idle"),
    ERROR("error"),
    DISCONNECTED("disconnected"),
}

/**
 * The chat side of a pod session (port of iOS `SessionChatModel`, itself a mirror of the web's
 * `session-chat.tsx`): the REST history first, then `/ws/sessions/:id/chat`.
 *
 * Sending waits for the server to be ready **and** for its history replay to finish: the server
 * says `ready`, then replays the stored conversation (`catchUp` frames, which the REST history
 * already covers and are skipped), and only then listens, with no end-of-replay marker; a message
 * sent inside that window can be lost. [settled] turns true after [settleDelay] without a replayed
 * frame, and [canSend] needs it.
 *
 * A socket that dies before `ready` with an `error` frame ("Session is not active", the pod was
 * cleaned up) is not retried: [fatal] turns true and the screen reloads the session. A reconnect
 * after a drop reloads the history (the server killed the reply in flight with the old socket).
 */
class SessionChatController(
    val sessionId: String,
    private val api: ApiClient,
    private val scope: CoroutineScope,
    private val socketFactory: (ApiClient, String) -> WebSocketClient = { client, path -> client.webSocket(path) },
    private val settleDelay: Duration = SETTLE_DELAY,
) {
    private val _rows = MutableStateFlow<List<SessionChatRow>>(emptyList())
    val rows: StateFlow<List<SessionChatRow>> = _rows.asStateFlow()

    private val _status = MutableStateFlow(SessionChatConnection.CONNECTING)
    val status: StateFlow<SessionChatConnection> = _status.asStateFlow()

    private val _model = MutableStateFlow<String?>(null)

    /** The model the next prompt runs on, once the server said (or you picked one). */
    val model: StateFlow<String?> = _model.asStateFlow()

    private val _costUsd = MutableStateFlow(0.0)

    /** The conversation's running cost as the server reports it. */
    val costUsd: StateFlow<Double> = _costUsd.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private val _settled = MutableStateFlow(false)

    /** The history replay after `ready` is over (see the class doc). */
    val settled: StateFlow<Boolean> = _settled.asStateFlow()

    private val _historyLoaded = MutableStateFlow(false)

    /** The REST history arrived (the chat shows a skeleton until then). */
    val historyLoaded: StateFlow<Boolean> = _historyLoaded.asStateFlow()

    private val _fatal = MutableStateFlow(false)

    /** The server refused the chat for good (see the class doc). */
    val fatal: StateFlow<Boolean> = _fatal.asStateFlow()

    /** iOS `canSend` (ready or idle) plus the replay gate. */
    val canSend: StateFlow<Boolean> =
        combine(_status, _settled) { status, settled ->
            settled && (status == SessionChatConnection.READY || status == SessionChatConnection.IDLE)
        }.stateIn(scope, SharingStarted.Eagerly, false)

    val isThinking: Boolean
        get() = _status.value == SessionChatConnection.THINKING

    private var socket: WebSocketClient? = null
    private var job: Job? = null
    private var settleJob: Job? = null
    private var openedOnce = false
    private var sawReady = false
    private var pendingFatal = false

    // region Lifecycle

    /** Loads the history, then connects (no-op while running). */
    fun start() {
        if (job != null) return
        _fatal.value = false
        _error.value = null
        _status.value = SessionChatConnection.CONNECTING
        val launched =
            scope.launch {
                loadHistory()
                val ws = socketFactory(api, sessionChatPath(sessionId))
                socket = ws
                ws.connect()
                // Completes when the socket is disconnected for good (stop, or a fatal close).
                ws.frames.collect(::handle)
            }
        job = launched
        launched.invokeOnCompletion {
            if (job === launched) {
                job = null
                socket = null
            }
        }
    }

    /** Closes the socket (the screen went away, or the session ended). */
    fun stop() {
        job?.cancel()
        job = null
        settleJob?.cancel()
        settleJob = null
        socket?.disconnect()
        socket = null
        openedOnce = false
        _settled.value = false
        _status.value = SessionChatConnection.DISCONNECTED
    }

    private suspend fun loadHistory() {
        try {
            val events = api.sessionChatHistory(sessionId)
            _rows.value =
                events.map { event ->
                    val id = event.id ?: UUID.randomUUID().toString()
                    if (event.isUserMessage) SessionChatRow.User(id, event.content) else SessionChatRow.Entry(id, event.asLogEntry(sessionId))
                }
            _historyLoaded.value = true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // The socket's replay stands in for the history (catch-up frames are kept then).
            _error.value = ErrorText.humanize(e, "the conversation")
        }
    }

    // endregion

    // region Frames

    /** One frame of the chat socket (internal for tests). */
    internal fun handle(frame: WsFrame) {
        when (frame) {
            WsFrame.Opened -> {
                _status.value = SessionChatConnection.CONNECTING
                _settled.value = false
                sawReady = false
                pendingFatal = false
                if (openedOnce) scope.launch { loadHistory() }
                openedOnce = true
            }
            is WsFrame.Closed -> {
                settleJob?.cancel()
                _settled.value = false
                _status.value = SessionChatConnection.DISCONNECTED
                frame.reason?.takeIf { it.isNotEmpty() }?.let { _error.value = it }
                if (pendingFatal || frame.code in WebSocketClient.CloseCode.permanent) {
                    // Retrying can't help (not active, no pod, not yours): stop, let the screen reload.
                    socket?.disconnect()
                    _fatal.value = true
                }
            }
            is WsFrame.Json -> handleJson(frame.value)
            is WsFrame.Text, is WsFrame.Binary -> Unit
        }
    }

    private fun handleJson(obj: JsonObject) {
        val catchUp = obj["catchUp"]?.boolValue == true
        if (catchUp) restartSettle()
        // The socket replays the stored history on connect; the REST history already has it.
        if (catchUp && _historyLoaded.value) return
        val message =
            try {
                OptioJson.decodeFromJsonElement(SessionChatServerMessage.serializer(), obj)
            } catch (_: Exception) {
                return
            }
        when (message) {
            is SessionChatServerMessage.ChatEvent -> {
                val event = message.event
                val rawType = obj["event"]?.get("type")?.stringValue
                if (rawType == "user_message") {
                    _rows.update { it + SessionChatRow.User(UUID.randomUUID().toString(), event.content) }
                    return
                }
                val entry =
                    AgentLogEntry(
                        taskId = event.taskId,
                        timestamp = event.timestamp,
                        sessionId = event.sessionId,
                        type = AgentLogEntry.TypeValue.fromRawOrNull(event.type.raw) ?: AgentLogEntry.TypeValue.TEXT,
                        content = event.content,
                        metadata = event.metadata,
                    )
                _rows.update { it + SessionChatRow.Entry(UUID.randomUUID().toString(), entry) }
            }
            is SessionChatServerMessage.CostUpdate -> _costUsd.value = message.costUsd
            is SessionChatServerMessage.Status -> {
                val status =
                    when (message.status) {
                        SessionChatStatus.READY -> SessionChatConnection.READY
                        SessionChatStatus.THINKING -> SessionChatConnection.THINKING
                        SessionChatStatus.IDLE -> SessionChatConnection.IDLE
                        SessionChatStatus.ERROR -> SessionChatConnection.ERROR
                        SessionChatStatus.UNKNOWN -> SessionChatConnection.READY
                    }
                _status.value = status
                message.model?.let { _model.value = it }
                message.costUsd?.let { _costUsd.value = it }
                if (status != SessionChatConnection.ERROR) _error.value = null
                if (message.status == SessionChatStatus.READY && !sawReady) {
                    sawReady = true
                    restartSettle()
                }
            }
            is SessionChatServerMessage.Error -> {
                _error.value = message.message
                // An error before `ready` is the server refusing the chat; the close follows.
                if (!sawReady) pendingFatal = true
            }
            is SessionChatServerMessage.Unknown -> Unit
        }
    }

    /** The replay is over once [settleDelay] passes without a replayed frame. */
    private fun restartSettle() {
        if (!sawReady) return
        settleJob?.cancel()
        _settled.value = false
        settleJob =
            scope.launch {
                delay(settleDelay)
                _settled.value = true
            }
    }

    // endregion

    // region Client → server

    /** Sends a prompt (shown at once as your bubble). False when the chat can't take one now. */
    fun send(text: String): Boolean {
        val content = text.trim()
        val ws = socket
        if (content.isEmpty() || ws == null || !canSend.value) return false
        val sent = ws.sendJson<SessionChatClientMessage>(SessionChatClientMessage.Message(content = content))
        if (!sent) {
            _error.value = "Not connected. Try again in a moment."
            return false
        }
        _rows.update { it + SessionChatRow.User(UUID.randomUUID().toString(), content) }
        _status.value = SessionChatConnection.THINKING
        return true
    }

    /** Stops the reply in progress (SIGINT to `claude`). */
    fun interrupt() {
        socket?.sendJson<SessionChatClientMessage>(SessionChatClientMessage.Interrupt)
    }

    /** Runs the next prompt on [model]. */
    fun setModel(model: String) {
        _model.value = model
        socket?.sendJson<SessionChatClientMessage>(SessionChatClientMessage.SetModel(model = model))
    }

    // endregion

    companion object {
        /** Quiet time after `ready` / the last replayed frame before sending is safe. */
        val SETTLE_DELAY: Duration = 500.milliseconds
    }
}
