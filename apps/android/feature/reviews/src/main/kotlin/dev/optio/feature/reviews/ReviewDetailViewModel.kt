package dev.optio.feature.reviews

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.PrReviewFileComment
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.failed
import java.time.Instant
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.minutes
import kotlin.time.Duration.Companion.seconds
import kotlin.time.toJavaDuration
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * One PR review (iOS `ReviewDetailModel`, web `/reviews/[id]`): the review with its runs and the
 * PR's live status, the editable draft (verdict, summary, inline comments) with Save / Submit,
 * Re-review / Cancel / Merge, the chat thread, and the agent's logs ([logs]: REST backfill +
 * `/ws/pr-reviews/:id/logs`).
 *
 * The screen calls [startLive] / [stopLive] as it becomes visible / hidden: the log socket and the
 * 5 s poll while the agent works only run while someone looks. The first load starts at once.
 */
internal class ReviewDetailViewModel(
    private val api: ApiClient,
    val reviewId: String,
    openSocket: (path: String) -> WebSocketClient = { path -> api.webSocket(path) },
    private val pollInterval: Duration = 5.seconds,
    private val chatPollInterval: Duration = 3.seconds,
    private val chatTimeout: Duration = 5.minutes,
    private val clock: () -> Instant = Instant::now,
) : ViewModel() {
    enum class Tab(val label: String) { DRAFT("Draft"), ACTIVITY("Activity"), RUNS("Runs") }

    /** An inline comment being edited; [line] is the text in the line field. */
    data class DraftComment(
        val key: Long,
        val path: String = "",
        val line: String = "",
        val side: String? = null,
        val body: String = "",
    ) {
        fun toWire() = PrReviewFileComment(path = path, line = line.trim().toDoubleOrNull(), side = side, body = body)
    }

    data class Draft(
        val summary: String = "",
        val verdict: String = "",
        val comments: List<DraftComment> = emptyList(),
        val dirty: Boolean = false,
    )

    data class Busy(
        val saving: Boolean = false,
        val submitting: Boolean = false,
        val merging: Boolean = false,
        val chatSending: Boolean = false,
        /** Re-review / cancel in flight: the menu is disabled. */
        val acting: Boolean = false,
    )

    /** A chat turn you sent (the reply shows in the logs). */
    data class UserMessage(
        val id: String,
        val text: String,
        /** ISO (normalised), to sort with the log lines. */
        val timestamp: String,
        val status: Status,
    ) {
        enum class Status { SENDING, SENT, FAILED }
    }

    private val _review = MutableStateFlow<LoadState<PrReview>>(LoadState.Idle)
    val review: StateFlow<LoadState<PrReview>> = _review.asStateFlow()

    private val _runs = MutableStateFlow<List<PrReviewRun>>(emptyList())
    val runs: StateFlow<List<PrReviewRun>> = _runs.asStateFlow()

    private val _prStatus = MutableStateFlow<PrStatus?>(null)
    val prStatus: StateFlow<PrStatus?> = _prStatus.asStateFlow()

    private val _userMessages = MutableStateFlow<List<UserMessage>>(emptyList())
    val userMessages: StateFlow<List<UserMessage>> = _userMessages.asStateFlow()

    private val _draft = MutableStateFlow(Draft())
    val draft: StateFlow<Draft> = _draft.asStateFlow()

    private val _busy = MutableStateFlow(Busy())
    val busy: StateFlow<Busy> = _busy.asStateFlow()

    private val _tab = MutableStateFlow(Tab.ACTIVITY)
    val tab: StateFlow<Tab> = _tab.asStateFlow()

    private val _events = Channel<ScreenEvent>(Channel.BUFFERED)
    val events: Flow<ScreenEvent> = _events.receiveAsFlow()

    /** The agent's logs: history of the latest run, then live lines. */
    val logs = RunLogStream(
        scope = viewModelScope,
        logEventType = "pr_review_run:log",
        stateEventTypes = setOf("pr_review_run:state_changed", "pr_review:state_changed", "pr_review:stale"),
        openSocket = openSocket,
    )

    private var tabChosen = false
    private var live = false
    private var pollJob: Job? = null
    private var chatPollJob: Job? = null
    private var nextCommentKey = 0L

    /** Assistant replies already known, so a new reply is spotted without trusting clocks. */
    private var knownReplies: Set<String>? = null

    init {
        viewModelScope.launch { load() }
        viewModelScope.launch { logs.stateChanges.collect { load(quiet = true) } }
    }

    // region Loading

    /** Starts the log stream and the working poll (the screen is visible). */
    fun startLive() {
        if (live) return
        live = true
        if (_review.value.value != null) viewModelScope.launch { load(quiet = true) }
        logs.start("/ws/pr-reviews/$reviewId/logs") { api.prReviewLogs(reviewId).map { it.toLogEntry() } }
        pollJob = viewModelScope.launch {
            combine(_review, _busy) { review, busy -> review.value?.isWorking == true || busy.chatSending }
                .distinctUntilChanged()
                .collectLatest { poll ->
                    while (poll) {
                        delay(pollInterval)
                        load(quiet = true)
                    }
                }
        }
    }

    /** Stops the socket and the poll (the screen went away or the app to the background). */
    fun stopLive() {
        live = false
        pollJob?.cancel()
        pollJob = null
        logs.stop()
    }

    /** Retry after a failed first load. */
    fun retry() {
        viewModelScope.launch { load() }
    }

    /** The menu's Refresh. */
    fun refresh() {
        viewModelScope.launch { load(quiet = true) }
    }

    /**
     * Reloads the review and its runs. A failure shows in place when there is nothing to show yet
     * (or when [quiet] is false); a quiet reload of a review on screen toasts it instead.
     */
    suspend fun load(quiet: Boolean = false) {
        val hadReview = _review.value.value != null
        if (!hadReview) _review.value = LoadState.Loading(null)
        try {
            val (review, runs) = coroutineScope {
                val review = async { api.getPrReview(reviewId) }
                val runs = async { runCatching { api.listPrReviewRuns(reviewId) }.getOrDefault(emptyList()) }
                review.await() to runs.await()
            }
            val previousRun = _runs.value.firstOrNull()?.id
            _runs.value = runs
            _review.value = LoadState.Loaded(review)
            if (!_draft.value.dirty) _draft.value = draftOf(review)
            if (!tabChosen) {
                tabChosen = true
                _tab.value = if (review.hasDraft) Tab.DRAFT else Tab.ACTIVITY
            }
            // A new run (re-review / chat) writes to a new log target.
            val latestRun = runs.firstOrNull()?.id
            if (previousRun != null && latestRun != previousRun) logs.reloadHistory()
            viewModelScope.launch { refreshPrStatus(review.prUrl) }
            if (review.hasDraft) viewModelScope.launch { hydrateChat() }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!hadReview || !quiet) {
                _review.update { it.failed(e) }
            } else {
                _events.send(ScreenEvent.Failure(e))
            }
        }
    }

    private suspend fun refreshPrStatus(prUrl: String) {
        runCatching { api.prStatus(prUrl) }.onSuccess { _prStatus.value = it }
    }

    /** Your turns from the server, keeping local echoes it doesn't know yet (iOS `load`). */
    private suspend fun hydrateChat() {
        val messages = runCatching { api.listPrReviewChat(reviewId) }.getOrNull() ?: return
        knownReplies = messages.filter { it.role == "assistant" }.map { it.id }.toSet()
        val hydrated = messages.filter { it.role == "user" }.map { m ->
            UserMessage(m.id, m.content, m.createdAt?.let(ReviewDates::iso).orEmpty(), UserMessage.Status.SENT)
        }
        val known = hydrated.map { it.text }.toSet()
        _userMessages.update { current ->
            val local = current.filter { it.id.startsWith(LOCAL_PREFIX) }
            hydrated + local.filter { it.text !in known || it.status != UserMessage.Status.SENT }
        }
    }

    private fun draftOf(review: PrReview) = Draft(
        summary = review.summary.orEmpty(),
        verdict = review.verdict.orEmpty(),
        comments = review.comments.map { c ->
            DraftComment(
                key = nextCommentKey++,
                path = c.path,
                line = c.line?.let { if (it % 1.0 == 0.0) it.toLong().toString() else it.toString() }.orEmpty(),
                side = c.side,
                body = c.body,
            )
        },
    )

    // endregion

    // region Draft editing

    fun selectTab(tab: Tab) {
        tabChosen = true
        _tab.value = tab
    }

    fun setVerdict(verdict: String) = _draft.update { it.copy(verdict = verdict, dirty = true) }

    fun setSummary(summary: String) = _draft.update { it.copy(summary = summary, dirty = true) }

    fun addComment() = _draft.update { it.copy(comments = it.comments + DraftComment(key = nextCommentKey++), dirty = true) }

    fun removeComment(key: Long) = _draft.update { d -> d.copy(comments = d.comments.filterNot { it.key == key }, dirty = true) }

    fun updateComment(key: Long, change: (DraftComment) -> DraftComment) =
        _draft.update { d -> d.copy(comments = d.comments.map { if (it.key == key) change(it) else it }, dirty = true) }

    // endregion

    // region Actions

    fun saveDraft() {
        viewModelScope.launch { saveDraftNow() }
    }

    private suspend fun saveDraftNow(): Boolean {
        _busy.update { it.copy(saving = true) }
        return try {
            val d = _draft.value
            val review = api.updatePrReview(
                reviewId,
                summary = d.summary,
                verdict = d.verdict.ifEmpty { null },
                fileComments = d.comments.map { it.toWire() },
            )
            _review.value = LoadState.Loaded(review)
            _draft.update { it.copy(dirty = false) }
            _events.send(ScreenEvent.Toast("Draft saved"))
            true
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _events.send(ScreenEvent.Failure(e))
            false
        } finally {
            _busy.update { it.copy(saving = false) }
        }
    }

    /** Saves unsaved edits first, then posts the review to the git host. */
    fun submit() {
        viewModelScope.launch {
            if (_draft.value.dirty && (!saveDraftNow() || _draft.value.dirty)) return@launch
            _busy.update { it.copy(submitting = true) }
            try {
                _review.value = LoadState.Loaded(api.submitPrReview(reviewId))
                _events.send(ScreenEvent.Toast("Review submitted"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            } finally {
                _busy.update { it.copy(submitting = false) }
            }
        }
    }

    fun reReview() = act("Re-review started", resetDraft = true) { api.reReviewPr(reviewId) }

    fun cancel() = act("Review cancelled") { api.cancelPrReview(reviewId) }

    private fun act(toast: String, resetDraft: Boolean = false, call: suspend () -> Unit) {
        viewModelScope.launch {
            _busy.update { it.copy(acting = true) }
            try {
                call()
                _events.send(ScreenEvent.Toast(toast))
                if (resetDraft) _draft.update { it.copy(dirty = false) }
                load(quiet = true)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            } finally {
                _busy.update { it.copy(acting = false) }
            }
        }
    }

    /** Merges the PR with `squash` / `merge` / `rebase`. */
    fun merge(method: String) {
        val review = _review.value.value ?: return
        viewModelScope.launch {
            _busy.update { it.copy(merging = true) }
            try {
                api.mergePullRequest(review.prUrl, method)
                _events.send(ScreenEvent.Toast("PR merged"))
                refreshPrStatus(review.prUrl)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            } finally {
                _busy.update { it.copy(merging = false) }
            }
        }
    }

    /**
     * Asks the reviewer [text]: shows it at once ("Sending…"), posts it, then polls the thread
     * every 3 s until the assistant answers (or 5 min pass), like the web. Returns once the message
     * is posted; the send survives the caller leaving.
     */
    suspend fun sendChat(text: String) {
        viewModelScope.launch { postChat(text) }.join()
    }

    private suspend fun postChat(text: String) {
        val localId = LOCAL_PREFIX + UUID.randomUUID()
        val start = clock()
        val repliesBefore = knownReplies
        _userMessages.update { it + UserMessage(localId, text, ReviewDates.iso(start), UserMessage.Status.SENDING) }
        _busy.update { it.copy(chatSending = true) }
        try {
            api.postPrReviewChat(reviewId, text)
            setStatus(localId, UserMessage.Status.SENT)
            chatPollJob?.cancel()
            chatPollJob = viewModelScope.launch { awaitReply(start, repliesBefore) }
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            setStatus(localId, UserMessage.Status.FAILED)
            _busy.update { it.copy(chatSending = false) }
            _events.send(ScreenEvent.Failure(e))
        }
    }

    private suspend fun awaitReply(start: Instant, repliesBefore: Set<String>?) {
        while (true) {
            delay(chatPollInterval)
            val messages = runCatching { api.listPrReviewChat(reviewId) }.getOrDefault(emptyList())
            val replied = messages.any { m ->
                m.role == "assistant" && if (repliesBefore != null) m.id !in repliesBefore else (m.createdAt ?: Instant.MIN) > start
            }
            val timedOut = java.time.Duration.between(start, clock()) > chatTimeout.toJavaDuration()
            if (replied || timedOut) {
                _busy.update { it.copy(chatSending = false) }
                load(quiet = true)
                return
            }
        }
    }

    private fun setStatus(id: String, status: UserMessage.Status) =
        _userMessages.update { list -> list.map { if (it.id == id) it.copy(status = status) else it } }

    // endregion

    override fun onCleared() {
        logs.stop()
    }

    private companion object {
        const val LOCAL_PREFIX = "local-"
    }
}
