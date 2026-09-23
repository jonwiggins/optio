package dev.optio.feature.agents

import androidx.compose.runtime.Immutable
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.OptioJson
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.model.PersistentAgentLogEvent
import dev.optio.core.model.PersistentAgentMessage
import dev.optio.core.model.PersistentAgentMessageSenderType
import dev.optio.core.model.PersistentAgentTurn
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import java.time.Clock
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/** The live tail of the agent's current turn (iOS `liveLogs` + `liveTurnId`). */
@Immutable
data class AgentLiveTail(
    val turnId: String? = null,
    val entries: List<AgentLogEntry> = emptyList(),
)

/** The agent row plus its inbox summary: what the header shows. */
@Immutable
data class AgentHeader(
    val agent: PersistentAgent,
    val inbox: PersistentAgentInbox = PersistentAgentInbox(),
)

/** What the agent screen shows, in one value (for the stateless content and screenshots). */
@Immutable
data class AgentDetailUi(
    val header: LoadState<AgentHeader> = LoadState.Idle,
    val messages: LoadState<List<PersistentAgentMessage>> = LoadState.Idle,
    val turns: LoadState<List<PersistentAgentTurn>> = LoadState.Idle,
    val triggers: LoadState<List<PersistentAgentTrigger>> = LoadState.Idle,
    val live: AgentLiveTail = AgentLiveTail(),
    val connected: Boolean = false,
) {
    val agent: PersistentAgent?
        get() = header.value?.agent
}

/** What the agent screen can do; the ViewModel implements it, previews use [Companion.None]. */
interface AgentDetailActions {
    /** Sends [body] to the agent's inbox (wakes it). True when the server took it. */
    suspend fun send(body: String): Boolean

    fun control(intent: PersistentAgentControlIntent)

    fun delete()

    fun deleteTrigger(triggerId: String)

    /**
     * Creates a trigger from [draft]: null on success (the sheet closes), else why it failed (the
     * sheet shows it; a toast would draw under the sheet). Runs to the end even when the caller
     * goes away (the sheet swiped down mid-save).
     */
    suspend fun createTrigger(draft: AgentTriggerDraft): Throwable?

    /** Pull to refresh: everything, awaited. */
    suspend fun refresh()

    companion object {
        val None: AgentDetailActions =
            object : AgentDetailActions {
                override suspend fun send(body: String) = true

                override fun control(intent: PersistentAgentControlIntent) = Unit

                override fun delete() = Unit

                override fun deleteTrigger(triggerId: String) = Unit

                override suspend fun createTrigger(draft: AgentTriggerDraft): Throwable? = null

                override suspend fun refresh() = Unit
            }
    }
}

/**
 * Screen state for one persistent agent (port of iOS `AgentDetailModel`): the agent row + inbox
 * summary, recent messages, turns, triggers, and a live log tail fed by
 * `/ws/persistent-agents/:id/events`. Mirrors the refresh choreography of the web's
 * `app/agents/[id]/page.tsx`: a message event refreshes the agent and the messages, a turn start or
 * state change the agent and the turns, a halted turn all three.
 *
 * Refreshes caused by events are coalesced per part (one request in flight, one queued), so a burst
 * of events (message → queued → provisioning → turn started → running → logs → halted → idle) costs
 * a handful of requests and never blocks the log stream. The socket is opened by [connect] while the
 * screen is shown and closed by [disconnect]; a reconnect refreshes everything (events may have been
 * missed) and the server's catch-up replay replaces the tail instead of duplicating it.
 */
class AgentDetailViewModel(
    val agentId: String,
    private val api: ApiClient,
    private val socketFactory: (ApiClient, String) -> WebSocketClient = { client, path -> client.webSocket(path) },
    private val clock: Clock = Clock.systemUTC(),
    /** Where a message sent from this phone is recorded, so the agent's next turn joins the Watch. */
    private val watchSources: WatchSources? = null,
) : ViewModel(), AgentDetailActions {
    /** One-shot outcomes the screen turns into toasts and navigation. */
    sealed interface Event {
        data class Success(val message: String) : Event

        data class Failure(val error: Throwable, val what: String? = null) : Event

        /** The agent is gone: leave the screen. */
        data object Deleted : Event
    }

    private enum class Part { AGENT, MESSAGES, TURNS, TRIGGERS }

    private val _header = MutableStateFlow<LoadState<AgentHeader>>(LoadState.Idle)
    val header: StateFlow<LoadState<AgentHeader>> = _header.asStateFlow()

    private val _messages = MutableStateFlow<LoadState<List<PersistentAgentMessage>>>(LoadState.Idle)

    /** Oldest → newest (the API answers newest first). */
    val messages: StateFlow<LoadState<List<PersistentAgentMessage>>> = _messages.asStateFlow()

    private val _turns = MutableStateFlow<LoadState<List<PersistentAgentTurn>>>(LoadState.Idle)

    /** Newest first. */
    val turns: StateFlow<LoadState<List<PersistentAgentTurn>>> = _turns.asStateFlow()

    private val _triggers = MutableStateFlow<LoadState<List<PersistentAgentTrigger>>>(LoadState.Idle)
    val triggers: StateFlow<LoadState<List<PersistentAgentTrigger>>> = _triggers.asStateFlow()

    private val _live = MutableStateFlow(AgentLiveTail())
    val live: StateFlow<AgentLiveTail> = _live.asStateFlow()

    private val _connected = MutableStateFlow(false)

    /** True while the events socket is open (the header's live dot). */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    private val _events = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = _events.receiveAsFlow()

    private val refreshers: Map<Part, Coalesced> =
        Part.entries.associateWith { part -> Coalesced(viewModelScope) { refreshPart(part) } }

    private var started = false
    private var socket: WebSocketClient? = null
    private var socketJob: Job? = null
    private var openedOnce = false

    /** True between a (re)open and the first frame after it: catch-up logs replace the tail. */
    private var freshConnection = false

    // region Lifecycle

    /** The screen appeared: the first time loads everything, later times refresh the agent. */
    fun appeared() {
        if (!started) {
            started = true
            viewModelScope.launch { loadAll() }
        } else {
            request(Part.AGENT)
        }
    }

    /** Retry after a failed load: every part again. */
    fun retry() {
        viewModelScope.launch { refresh() }
    }

    /** Opens the events socket (no-op while one is open). */
    fun connect() {
        if (socket != null) return
        val ws = socketFactory(api, agentEventsPath(agentId))
        socket = ws
        ws.connect()
        socketJob = viewModelScope.launch { ws.frames.collect(::handle) }
    }

    /** Closes the events socket (the screen went away). */
    fun disconnect() {
        socketJob?.cancel()
        socketJob = null
        socket?.disconnect()
        socket = null
        _connected.value = false
    }

    override fun onCleared() {
        disconnect()
    }

    // endregion

    // region Loading

    private suspend fun loadAll() = coroutineScope {
        launch { _header.load { fetchHeader() } }
        launch { _messages.load { fetchMessages() } }
        launch { _turns.load { api.listPersistentAgentTurns(agentId, limit = 30) } }
        launch { _triggers.load { api.listPersistentAgentTriggers(agentId) } }
    }

    override suspend fun refresh() {
        coroutineScope { Part.entries.forEach { part -> launch { refreshers.getValue(part).now() } } }
    }

    private fun request(vararg parts: Part) = parts.forEach { refreshers.getValue(it).request() }

    private suspend fun fetchHeader(): AgentHeader =
        api.getPersistentAgent(agentId).let { AgentHeader(it.agent, it.inbox ?: PersistentAgentInbox()) }

    /** Newest-first from the API → oldest-first for the transcript (iOS `reversed()`). */
    private suspend fun fetchMessages(): List<PersistentAgentMessage> = api.listPersistentAgentMessages(agentId, limit = 50).reversed()

    private suspend fun refreshPart(part: Part) {
        when (part) {
            Part.AGENT -> _header.quietly { fetchHeader() }
            Part.MESSAGES -> _messages.quietly { fetchMessages() }
            Part.TURNS -> _turns.quietly { api.listPersistentAgentTurns(agentId, limit = 30) }
            Part.TRIGGERS -> _triggers.quietly { api.listPersistentAgentTriggers(agentId) }
        }
    }

    // endregion

    // region Actions

    override suspend fun send(body: String): Boolean {
        val text = body.trim()
        if (text.isEmpty()) return false
        // Shown at once as a pending bubble; the refresh replaces it with the stored row.
        val optimistic =
            PersistentAgentMessage(
                id = "local-${UUID.randomUUID()}",
                agentId = agentId,
                senderType = PersistentAgentMessageSenderType.USER,
                body = text,
                broadcasted = false,
                receivedAt = clock.instant(),
            )
        _messages.update { state -> LoadState.Loaded(state.value.orEmpty() + optimistic) }
        return try {
            api.sendPersistentAgentMessage(agentId, text)
            // The turn it wakes joins the Watch for an hour (iOS `RecentAgentSends.record`).
            watchSources?.recordAgentSend(agentId)
            request(Part.AGENT, Part.MESSAGES)
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _messages.update { state -> LoadState.Loaded(state.value.orEmpty().filterNot { it.id == optimistic.id }) }
            _events.send(Event.Failure(e))
            false
        }
    }

    override fun control(intent: PersistentAgentControlIntent) {
        viewModelScope.launch {
            try {
                api.controlPersistentAgent(agentId, intent)
                _events.send(Event.Success(controlMessage(intent)))
                refreshers.getValue(Part.AGENT).now()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(Event.Failure(e))
            }
        }
    }

    override fun delete() {
        viewModelScope.launch {
            try {
                api.deletePersistentAgent(agentId)
                disconnect()
                _events.send(Event.Deleted)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(Event.Failure(e))
            }
        }
    }

    override fun deleteTrigger(triggerId: String) {
        val before = _triggers.value.value.orEmpty()
        _triggers.value = LoadState.Loaded(before.filterNot { it.id == triggerId })
        viewModelScope.launch {
            try {
                api.deletePersistentAgentTrigger(agentId, triggerId)
                _events.send(Event.Success("Trigger deleted"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _triggers.value = LoadState.Loaded(before)
                _events.send(Event.Failure(e))
            }
        }
    }

    override suspend fun createTrigger(draft: AgentTriggerDraft): Throwable? =
        viewModelScope.async {
            try {
                val trigger = api.createPersistentAgentTrigger(agentId, draft.input())
                _triggers.update { state -> LoadState.Loaded(listOf(trigger) + state.value.orEmpty().filterNot { it.id == trigger.id }) }
                _events.send(Event.Success("${draft.type.label} trigger added"))
                request(Part.TRIGGERS)
                null
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                // Also a toast, for when the sheet was dismissed before the answer came.
                _events.send(Event.Failure(e))
                e
            }
        }.await()

    // endregion

    // region Live events

    /** One frame of the events socket (internal for tests). */
    internal fun handle(frame: WsFrame) {
        when (frame) {
            WsFrame.Opened -> {
                _connected.value = true
                freshConnection = true
                // Anything could have happened while the socket was down.
                if (openedOnce) request(Part.AGENT, Part.MESSAGES, Part.TURNS)
                openedOnce = true
            }
            is WsFrame.Closed -> _connected.value = false
            is WsFrame.Json -> handleJson(frame.value)
            is WsFrame.Text, is WsFrame.Binary -> Unit
        }
    }

    private fun handleJson(obj: JsonObject) {
        val type = obj["type"]?.stringValue
        val catchUp = obj["catchUp"]?.boolValue == true
        if (type == "persistent_agent:log") {
            val event =
                try {
                    OptioJson.decodeFromJsonElement(PersistentAgentLogEvent.serializer(), obj)
                } catch (_: Exception) {
                    return
                }
            // The server replays the latest turn's logs on every connect: start the tail over.
            val replace = catchUp && freshConnection
            freshConnection = false
            appendLog(event, replace)
            return
        }
        freshConnection = false
        when (type) {
            "persistent_agent:turn_started" -> {
                _live.value = AgentLiveTail(turnId = obj["turnId"]?.stringValue)
                request(Part.AGENT, Part.TURNS)
            }
            "persistent_agent:turn_halted" -> request(Part.AGENT, Part.MESSAGES, Part.TURNS)
            "persistent_agent:state_changed" -> request(Part.AGENT, Part.TURNS)
            "persistent_agent:message" -> request(Part.AGENT, Part.MESSAGES)
            else -> Unit
        }
    }

    private fun appendLog(event: PersistentAgentLogEvent, replace: Boolean) {
        val entry =
            AgentLogEntry(
                taskId = agentId,
                timestamp = event.timestamp,
                type = AgentLogEntry.TypeValue.fromRawOrNull(event.logType ?: "text") ?: AgentLogEntry.TypeValue.TEXT,
                content = event.content,
                metadata = event.metadata,
            )
        _live.update { tail ->
            // A new turn's output anchors the tail to it.
            val kept = if (replace || (tail.turnId != null && tail.turnId != event.turnId)) emptyList() else tail.entries
            AgentLiveTail(turnId = event.turnId, entries = (kept + entry).takeLast(MAX_LIVE_LOGS))
        }
    }

    // endregion

    companion object {
        /** iOS keeps the last 2000 live lines. */
        const val MAX_LIVE_LOGS = 2000

        internal fun controlMessage(intent: PersistentAgentControlIntent): String =
            when (intent) {
                PersistentAgentControlIntent.PAUSE -> "Pausing"
                PersistentAgentControlIntent.RESUME -> "Resuming"
                PersistentAgentControlIntent.ARCHIVE -> "Archived"
                PersistentAgentControlIntent.RESTART -> "Restarting"
                PersistentAgentControlIntent.UNKNOWN -> "Sent"
            }
    }
}

/**
 * A refresh that runs at most once at a time: requests while one runs queue exactly one more run
 * (it reads the latest server state), so bursts collapse. Main-thread only (viewModelScope).
 */
internal class Coalesced(
    private val scope: CoroutineScope,
    private val block: suspend () -> Unit,
) {
    private var job: Job? = null
    private var again = false

    fun request() {
        if (job?.isActive == true) {
            again = true
            return
        }
        job =
            scope.launch {
                do {
                    again = false
                    block()
                } while (again)
            }
    }

    /** Requests a run and waits for it (pull to refresh). */
    suspend fun now() {
        request()
        job?.join()
    }
}

/**
 * A background refresh: the value updates on success, and a failure only shows when there is
 * nothing on screen yet (iOS ignores failed refreshes of messages, turns and triggers).
 */
private suspend fun <T> MutableStateFlow<LoadState<T>>.quietly(block: suspend () -> T) {
    try {
        value = LoadState.Loaded(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        if (value.value == null) value = LoadState.Failed(e)
    }
}
