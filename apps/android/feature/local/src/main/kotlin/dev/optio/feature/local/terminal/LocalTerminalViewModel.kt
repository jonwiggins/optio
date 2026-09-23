package dev.optio.feature.local.terminal

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.EventHub
import dev.optio.core.network.unknown
import dev.optio.core.terminal.TerminalState
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.local.api.deleteLocalTerminal
import dev.optio.feature.local.api.getLocalTerminal
import dev.optio.feature.local.api.getLocalTerminalTranscript
import dev.optio.feature.local.api.killLocalTerminal
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.renameLocalTerminal
import dev.optio.feature.local.api.resumeLocalTerminal
import dev.optio.feature.local.api.sendLocalTerminalInput
import dev.optio.feature.local.api.startLocalTerminal
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.LocalSessionView
import dev.optio.feature.local.model.LocalSessionViewRule
import dev.optio.feature.local.model.withLive
import dev.optio.feature.local.snooze.SnoozeStore
import dev.optio.feature.local.stream.LocalTerminalStream
import dev.optio.feature.local.stream.StreamSocket
import dev.optio.feature.local.stream.TerminalSink
import dev.optio.feature.local.stream.TerminalStateSink
import dev.optio.feature.local.stream.WebSocketStreamSocket
import dev.optio.feature.local.transcript.LocalTranscriptModel
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flatMapLatest
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive

/**
 * The focus view of one Local terminal (iOS `LocalTerminalScreen`'s state): the terminal row (REST,
 * polled every 10 s and nudged by `local:changed`), its transcript ([LocalTranscriptModel]) and the
 * stream ([LocalTerminalStream]) feeding [screen], the emulator the Screen face renders.
 *
 * [screen] lives here, not in the composable, so switching Transcript ⇄ Screen and rotating keep the
 * screen. The stream is connected only while the screen is on display ([attach] / [detach]): its
 * `status` / `exit` frames drive the header on both faces, and a screen that comes back replays.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LocalTerminalViewModel(
    private val api: ApiClient,
    val terminalId: String,
    compose: Boolean = false,
    private val eventHub: EventHub? = null,
    private val snoozeStore: SnoozeStore? = null,
    terminalFactory: () -> TerminalState = { TerminalState() },
    private val sinkFactory: (TerminalState) -> TerminalSink = ::TerminalStateSink,
    private val socketFactory: (ApiClient, String) -> StreamSocket = WebSocketStreamSocket::open,
    private val pollInterval: Duration = POLL_INTERVAL,
) : ViewModel() {
    /** One-shot things the screen does: toasts, leaving, opening another terminal. */
    sealed interface Event {
        data class Toast(val message: String, val tone: Tone = Tone.SUCCESS) : Event

        data class Failed(val error: Throwable, val verb: String) : Event

        /** The terminal is gone (deleted): leave the screen. */
        data object Closed : Event

        /** Resume chat opened a new terminal: go there. */
        data class Open(val route: LocalTerminalRoute) : Event
    }

    private val _terminal = MutableStateFlow<LoadState<LocalTerminal>>(LoadState.Loading())
    val terminal: StateFlow<LoadState<LocalTerminal>> = _terminal.asStateFlow()

    private val _hosts = MutableStateFlow<List<LocalHost>>(emptyList())

    /** The caller's paired hosts (the header names the host when there is more than one). */
    val hosts: StateFlow<List<LocalHost>> = _hosts.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _viewChoice = MutableStateFlow<LocalSessionView?>(null)

    /** An explicit Transcript ⇄ Screen choice; remembered while this screen is on the stack. */
    val viewChoice: StateFlow<LocalSessionView?> = _viewChoice.asStateFlow()

    private val _focusComposer = MutableStateFlow(compose)

    /** `?compose=1`: raise the composer (or, without a transcript, the terminal's keyboard) once. */
    val focusComposer: StateFlow<Boolean> = _focusComposer.asStateFlow()

    private val eventChannel = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = eventChannel.receiveAsFlow()

    /** The emulator of the Screen face; fed by the stream on both faces. */
    val screen: TerminalState = terminalFactory()
    private val sink: TerminalSink = sinkFactory(screen)

    val transcript =
        LocalTranscriptModel(
            scope = viewModelScope,
            fetch = { after, limit -> api.getLocalTerminalTranscript(terminalId, after, limit) },
        )

    private val _stream = MutableStateFlow<LocalTerminalStream?>(null)

    /** The live stream while the screen is on display; null otherwise. */
    val stream: StateFlow<LocalTerminalStream?> = _stream.asStateFlow()

    /** The current stream's state (a fresh one's defaults while none runs). */
    val streamState: StateFlow<LocalTerminalStream.State> =
        _stream
            .flatMapLatest { it?.state ?: flowOf(LocalTerminalStream.State(conn = LocalTerminalStream.ConnState.CONNECTING)) }
            .stateIn(viewModelScope, SharingStarted.Eagerly, LocalTerminalStream.State())

    /** Which face shows, or null while it can't be decided yet ([LocalSessionViewRule]). */
    val sessionView: StateFlow<LocalSessionView?> =
        combine(_viewChoice, transcript.state) { choice, t ->
            LocalSessionViewRule.resolve(choice, hasTranscript = t.hasEntries, loaded = t.loaded)
        }.stateIn(viewModelScope, SharingStarted.Eagerly, null)

    private var visible = false
    private var transcriptStarted = false
    private var pollJob: Job? = null
    private var eventsJob: Job? = null

    init {
        screen.onInput = { bytes -> _stream.value?.sendInput(bytes) }
        screen.onInteraction = { _stream.value?.onInteraction() }
        screen.onGridSizeChanged = { grid -> _stream.value?.onGridSizeChanged(grid) }
        screen.onNaturalGridChanged = { _stream.value?.onNaturalGridChanged() }
        viewModelScope.launch { load() }
        viewModelScope.launch {
            try {
                _hosts.value = api.listLocalHosts()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Only used for the host name; the terminal reads fine without it.
            }
        }
    }

    // region Visibility

    /** The screen is on display: poll, stream, listen for nudges. */
    fun attach() {
        if (visible) return
        visible = true
        transcript.resume()
        if (_terminal.value.value != null) startStream()
        pollJob?.cancel()
        pollJob =
            viewModelScope.launch {
                while (isActive) {
                    delay(pollInterval)
                    load(quiet = true)
                }
            }
        val hub = eventHub
        eventsJob?.cancel()
        eventsJob =
            if (hub == null) {
                null
            } else {
                viewModelScope.launch {
                    hub.unknown("local:changed")
                        .filter { it["terminalId"]?.jsonPrimitive?.content == terminalId }
                        .collect {
                            load(quiet = true)
                            transcript.poke()
                        }
                }
            }
    }

    /** The screen went away (another tab, the app in the background): stop the socket and the polls. */
    fun detach() {
        if (!visible) return
        visible = false
        pollJob?.cancel()
        pollJob = null
        eventsJob?.cancel()
        eventsJob = null
        transcript.pause()
        _stream.value?.disconnect()
        _stream.value = null
    }

    override fun onCleared() {
        _stream.value?.disconnect()
        _stream.value = null
        transcript.stop()
        screen.dispose()
    }

    // endregion

    // region Data

    /** GET the terminal; a quiet reload keeps what's on screen when it fails. */
    suspend fun load(quiet: Boolean = false) {
        val before = _terminal.value.value
        if (quiet && before != null) {
            try {
                applyTerminal(api.getLocalTerminal(terminalId))
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Keep the last good row; the next poll retries.
            }
            return
        }
        val loaded = _terminal.load { api.getLocalTerminal(terminalId) } ?: return
        onTerminalChanged(before, loaded)
    }

    fun retry() {
        viewModelScope.launch { load() }
    }

    private fun applyTerminal(t: LocalTerminal) {
        val before = _terminal.value.value
        _terminal.value = LoadState.Loaded(t)
        onTerminalChanged(before, t)
    }

    /** React to a new row: start the transcript once, re-attach on leaving `pending`, follow liveness. */
    private fun onTerminalChanged(
        before: LocalTerminal?,
        now: LocalTerminal,
    ) {
        val dead = LocalPresentation.isDead(now)
        if (!transcriptStarted) {
            transcriptStarted = true
            transcript.start(live = !dead)
            if (!visible) transcript.pause()
        } else {
            transcript.setLive(!dead)
        }
        if (visible) {
            val stream = _stream.value
            when {
                stream == null -> startStream()
                // The stream only attaches to a terminal that is launching/running when it connects.
                before?.state == LocalTerminalState.PENDING && now.state != LocalTerminalState.PENDING -> stream.reconnect()
            }
        }
    }

    private fun startStream() {
        if (_stream.value != null) return
        val s =
            LocalTerminalStream(
                terminalId = terminalId,
                scope = viewModelScope,
                sink = sink,
                openSocket = { socketFactory(api, terminalId) },
            )
        s.onStatus = { state, attention -> applyStatus(state, attention) }
        s.onExit = { code -> onExit(code) }
        _stream.value = s
        s.connect()
    }

    private fun applyStatus(
        state: LocalTerminalState,
        attention: LocalAttentionState,
    ) {
        val t = _terminal.value.value ?: return
        if (t.state == state && t.attentionState == attention) return
        val next = t.withLive(state = state, attentionState = attention)
        _terminal.value = LoadState.Loaded(next)
        transcript.setLive(!LocalPresentation.isDead(next))
    }

    private fun onExit(code: Int?) {
        val t = _terminal.value.value
        if (t != null && !LocalPresentation.isDead(t)) {
            _terminal.value = LoadState.Loaded(t.withLive(state = LocalTerminalState.EXITED, exitCode = code?.toDouble()))
            transcript.setLive(false)
        }
        viewModelScope.launch { load(quiet = true) }
    }

    // endregion

    // region Faces

    fun choose(view: LocalSessionView) {
        _viewChoice.value = view
    }

    fun composerFocused() {
        _focusComposer.value = false
    }

    /** "Use this screen": take the PTY grid for this phone. */
    fun claim() {
        _stream.value?.claim()
    }

    /** "Reconnect" after the stream gave up. */
    fun reconnect() {
        val s = _stream.value
        if (s == null) startStream() else s.reconnect()
    }

    // endregion

    // region Actions

    fun start() =
        action("start the terminal") {
            applyTerminal(api.startLocalTerminal(terminalId))
            toast("Starting terminal…")
        }

    fun kill(signal: String? = null) =
        action("kill the terminal") {
            api.killLocalTerminal(terminalId, signal)
            toast(if (signal == "SIGKILL") "Kill signal sent (SIGKILL)" else "Kill signal sent")
            load(quiet = true)
        }

    fun delete() =
        action("delete the terminal") {
            api.deleteLocalTerminal(terminalId)
            _stream.value?.disconnect()
            _stream.value = null
            toast("Terminal deleted")
            eventChannel.send(Event.Closed)
        }

    fun resume() =
        action("resume the session") {
            val resumed = api.resumeLocalTerminal(terminalId)
            toast("Resuming session in a new terminal")
            eventChannel.send(Event.Open(LocalTerminalRoute(resumed.id)))
        }

    fun rename(title: String) {
        val trimmed = title.trim()
        if (trimmed.isEmpty() || trimmed == _terminal.value.value?.title) return
        action("rename the terminal") { applyTerminal(api.renameLocalTerminal(terminalId, trimmed)) }
    }

    /** "Later": out of the needs-you queue for 15 minutes (the server's snooze, else this phone's). */
    fun snooze() {
        val store = snoozeStore ?: return
        action("snooze it") {
            val outcome = store.snooze(terminalId, api)
            toast(if (outcome == SnoozeStore.Outcome.SERVER) "Snoozed for ${SnoozeStore.DEFAULT_MINUTES} min" else "Snoozed on this phone for ${SnoozeStore.DEFAULT_MINUTES} min")
            load(quiet = true)
        }
    }

    fun unsnooze() {
        val store = snoozeStore ?: return
        action("put it back in the queue") {
            store.unsnooze(terminalId, api)
            toast("Back in the needs-you queue")
            load(quiet = true)
        }
    }

    /** The local window this phone keeps when the server couldn't snooze. */
    fun localSnoozeUntil() = snoozeStore?.snoozedUntil(terminalId)

    /** "Send text" (REST `POST /input`): works when the stream is disconnected. */
    fun sendViaRest(text: String) {
        if (text.isEmpty()) return
        viewModelScope.launch {
            try {
                api.sendLocalTerminalInput(terminalId, text)
                toast("Sent")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, "send the text"))
            }
        }
    }

    /**
     * The Transcript composer: the message plus Enter, over the stream when it's connected, else the
     * REST fallback. Never claims the grid (the Screen face isn't in use).
     */
    suspend fun sendToAgent(text: String) {
        val payload = text + "\r"
        val stream = _stream.value
        if (stream == null || !stream.sendInput(payload)) {
            try {
                api.sendLocalTerminalInput(terminalId, payload)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, "send the message"))
                return
            }
        }
        // The daemon flushes the transcript on the agent's prompt hook; fetch it a moment later.
        viewModelScope.launch {
            delay(TRANSCRIPT_NUDGE)
            transcript.poke()
        }
    }

    private suspend fun toast(message: String) {
        eventChannel.send(Event.Toast(message))
    }

    private fun action(
        what: String,
        block: suspend () -> Unit,
    ) {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, what))
            } finally {
                _busy.value = false
            }
        }
    }

    // endregion

    companion object {
        /** iOS polls the row every 10 s as a fallback to the stream's status frames. */
        val POLL_INTERVAL: Duration = 10.seconds

        /** How long after a composer send the transcript is fetched again. */
        val TRANSCRIPT_NUDGE: Duration = 1500.milliseconds
    }
}
