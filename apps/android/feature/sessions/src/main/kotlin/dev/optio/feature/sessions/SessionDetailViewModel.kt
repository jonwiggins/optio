package dev.optio.feature.sessions

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.InteractiveSession
import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.SessionPr
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.terminal.TerminalState
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * A pod session (port of iOS `SessionDetailView`'s state, mirroring the web's
 * `app/sessions/[id]/page.tsx`): the session and its repo's model config, the PRs it opened (polled
 * every 30 s while it is active and on screen), the agent [chat], and the [shell].
 *
 * While the screen is shown ([connect]) the chat socket stays open, and the terminal's too once its
 * chip has been opened, so switching chips resets neither; [disconnect] closes both.
 */
class SessionDetailViewModel(
    val sessionId: String,
    private val api: ApiClient,
    private val socketFactory: (ApiClient, String) -> WebSocketClient = { client, path -> client.webSocket(path) },
    private val terminalOverride: TerminalState? = null,
    private val prPollInterval: Duration = 30.seconds,
) : ViewModel() {
    sealed interface Event {
        data class Success(val message: String) : Event

        data class Failure(val error: Throwable) : Event
    }

    private val _session = MutableStateFlow<LoadState<SessionEnvelope>>(LoadState.Idle)
    val session: StateFlow<LoadState<SessionEnvelope>> = _session.asStateFlow()

    private val _prs = MutableStateFlow<List<SessionPr>>(emptyList())
    val prs: StateFlow<List<SessionPr>> = _prs.asStateFlow()

    private val _ending = MutableStateFlow(false)
    val ending: StateFlow<Boolean> = _ending.asStateFlow()

    private val _events = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = _events.receiveAsFlow()

    val chat = SessionChatController(sessionId, api, viewModelScope, socketFactory)

    private var shellInstance: SessionTerminalController? = null

    /** The terminal, created on first use (on the main thread: the emulator lives there). */
    val shell: SessionTerminalController
        get() =
            shellInstance ?: SessionTerminalController(sessionId, api, viewModelScope, terminalOverride ?: TerminalState(), socketFactory)
                .also { shellInstance = it }

    private var shellWanted = false
    private var shown = false
    private var started = false
    private var pollJob: Job? = null

    val isActive: Boolean
        get() = _session.value.value?.session?.state == InteractiveSessionState.ACTIVE

    init {
        // The chat was refused for good (not active any more, pod gone): see what the session is now.
        viewModelScope.launch { chat.fatal.filter { it }.collect { refresh() } }
    }

    /** The screen appeared: loads the first time. */
    fun appeared() {
        if (started) return
        started = true
        viewModelScope.launch { load() }
    }

    private suspend fun load() {
        _session.load { api.getSession(sessionId) } ?: return
        _prs.value = runCatching { api.listSessionPrs(sessionId) }.getOrDefault(_prs.value)
        if (shown) startLive()
    }

    /** Pull to refresh / retry: the session and its PRs. */
    suspend fun refresh() {
        val before = isActive
        _session.load { api.getSession(sessionId) }
        refreshPrs()
        if (before && !isActive) stopLive()
    }

    suspend fun refreshPrs() {
        try {
            _prs.value = api.listSessionPrs(sessionId)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the list on screen (iOS `?? prs`).
        }
    }

    // region Live

    /** The screen is shown: open the chat (and the terminal if it was opened) and poll PRs. */
    fun connect() {
        shown = true
        if (_session.value.value != null) startLive()
    }

    /** The screen went away: close both sockets and stop polling. */
    fun disconnect() {
        shown = false
        stopLive()
    }

    /** The Terminal chip was opened: its socket joins the live set. */
    fun openShell() {
        shellWanted = true
        if (shown && isActive) shell.start()
    }

    private fun startLive() {
        if (!isActive) return
        chat.start()
        if (shellWanted) shell.start()
        if (pollJob?.isActive != true) {
            pollJob =
                viewModelScope.launch {
                    while (true) {
                        delay(prPollInterval)
                        if (!isActive) break
                        refreshPrs()
                    }
                }
        }
    }

    private fun stopLive() {
        chat.stop()
        shellInstance?.stop()
        pollJob?.cancel()
        pollJob = null
    }

    override fun onCleared() {
        stopLive()
        shellInstance?.terminal?.dispose()
    }

    // endregion

    /** Ends the session: the worktree is cleaned up and the pod torn down. */
    fun end() {
        if (_ending.value) return
        viewModelScope.launch {
            _ending.value = true
            try {
                val ended = api.endSession(sessionId)
                _session.value = LoadState.Loaded(SessionEnvelope(ended, _session.value.value?.modelConfig))
                stopLive()
                _events.send(Event.Success("Session ended"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(Event.Failure(e))
            } finally {
                _ending.value = false
            }
        }
    }
}

/** The chat's cost while it runs, else the stored one (iOS `displayCost`). */
internal fun displayCost(live: Double, session: InteractiveSession?): Double =
    if (live > 0) live else session?.costUsd?.toDoubleOrNull() ?: 0.0

/** The screen title: the session's name, else its branch, else "Session <id>" (web header). */
internal fun sessionTitle(session: InteractiveSession?): String {
    if (session == null) return "Session"
    return session.title?.takeIf { it.isNotBlank() }
        ?: session.branch.takeIf { it.isNotEmpty() }
        ?: "Session ${session.id.take(8)}"
}
