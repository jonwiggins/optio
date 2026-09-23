package dev.optio.feature.reviews

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.network.ApiClient
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
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

/** One-off things a screen's model asks the UI to do (toast, open a screen, leave). */
internal sealed interface ScreenEvent {
    data class Toast(val message: String) : ScreenEvent

    data class Failure(val error: Throwable, val what: String? = null) : ScreenEvent

    data class Open(val route: NavKey) : ScreenEvent

    data object Close : ScreenEvent
}

/**
 * Work › Reviews (iOS `ReviewsListModel`): open PRs across the workspace's repos with their review
 * state, the paste-a-PR-URL launcher, and per-PR "Review with Optio" / "Approve & merge".
 */
internal class ReviewsListViewModel(private val api: ApiClient) : ViewModel() {
    /** What the list shows. */
    data class Data(
        val prs: List<PullRequestSummary>,
        val repos: List<RepoSummary>,
    )

    /** Filters and in-flight actions. */
    data class Ui(
        /** "" = all, `unreviewed`, or a review state (client-side, like iOS). */
        val stateFilter: String = "",
        /** A repo id ("" = all repos): refetches. */
        val repoFilter: String = "",
        val reviewingUrl: String? = null,
        val mergingUrl: String? = null,
        val launchingUrl: Boolean = false,
        /** The "Paste a PR URL to review" field. */
        val prUrl: String = "",
    )

    private val _state = MutableStateFlow<LoadState<Data>>(LoadState.Idle)
    val state: StateFlow<LoadState<Data>> = _state.asStateFlow()

    private val _ui = MutableStateFlow(Ui())
    val ui: StateFlow<Ui> = _ui.asStateFlow()

    private val _events = Channel<ScreenEvent>(Channel.BUFFERED)
    val events: Flow<ScreenEvent> = _events.receiveAsFlow()

    private var loadJob: Job? = null

    /** The PRs the state filter keeps. */
    fun filtered(data: Data, filter: String = _ui.value.stateFilter): List<PullRequestSummary> =
        data.prs.filter { pr ->
            when (filter) {
                "" -> true
                "unreviewed" -> pr.review == null
                else -> pr.review?.state == filter
            }
        }

    /** Loads in the background (first show, the section coming back, a filter change). */
    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { fetch() }
    }

    /** Loads and returns when done (pull to refresh, Retry). */
    suspend fun reload() {
        loadJob?.cancel()
        fetch()
    }

    private suspend fun fetch() {
        val repoId = _ui.value.repoFilter.ifEmpty { null }
        _state.load {
            coroutineScope {
                val prs = async { api.listOpenPullRequests(repoId) }
                val repos = async { runCatching { api.listRepoSummaries() }.getOrDefault(emptyList()) }
                Data(prs.await(), repos.await())
            }
        }
    }

    fun setStateFilter(filter: String) = _ui.update { it.copy(stateFilter = filter) }

    fun setRepoFilter(repoId: String) {
        if (repoId == _ui.value.repoFilter) return
        _ui.update { it.copy(repoFilter = repoId) }
        refresh()
    }

    fun setPrUrl(text: String) = _ui.update { it.copy(prUrl = text) }

    /** Reviews the PR pasted into the URL field (cleared once the review starts). */
    fun launchFromUrlField() = launchReview(_ui.value.prUrl, fromUrlField = true)

    /** "Review with Optio" / "Re-review" on a row, or the URL field; opens the review on success. */
    fun launchReview(prUrl: String, fromUrlField: Boolean = false) {
        val url = prUrl.trim()
        if (url.isEmpty() || _ui.value.launchingUrl) return
        viewModelScope.launch {
            _ui.update { if (fromUrlField) it.copy(launchingUrl = true) else it.copy(reviewingUrl = url) }
            try {
                val review = api.createPrReview(url)
                _events.send(ScreenEvent.Toast("Review started"))
                if (fromUrlField) _ui.update { it.copy(prUrl = "") }
                _events.send(ScreenEvent.Open(ReviewDetailRoute(review.id)))
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            } finally {
                _ui.update { it.copy(launchingUrl = false, reviewingUrl = null) }
            }
        }
    }

    /**
     * "Approve & merge" (iOS `approveAndMerge`): best-effort approve + submit of an existing draft
     * (the web does the same), then a squash merge and a reload.
     */
    fun approveAndMerge(pr: PullRequestSummary) {
        viewModelScope.launch {
            _ui.update { it.copy(mergingUrl = pr.url) }
            try {
                pr.review?.let { review ->
                    runCatching { api.updatePrReview(review.id, summary = "Approved by user", verdict = "approve", fileComments = null) }
                    runCatching { api.submitPrReview(review.id) }
                }
                api.mergePullRequest(pr.url, "squash")
                _events.send(ScreenEvent.Toast("PR #${pr.number} merged"))
                fetch()
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            } finally {
                _ui.update { it.copy(mergingUrl = null) }
            }
        }
    }
}
