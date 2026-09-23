package dev.optio.feature.reviews

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * Issues assigned from an issue's detail screen, so the Inbox list marks them at once (iOS passes
 * an `onAssigned` closure; screens here are separate back-stack entries).
 */
internal object IssueAssignments {
    data class Assigned(val identity: String, val taskId: String?)

    private val _events = MutableSharedFlow<Assigned>(extraBufferCapacity = 16)
    val events: SharedFlow<Assigned> = _events.asSharedFlow()

    fun publish(identity: String, taskId: String?) {
        _events.tryEmit(Assigned(identity, taskId))
    }
}

/**
 * Work › Inbox (iOS `IssuesListModel`): issues across the workspace's repos (and external
 * trackers) with an Open / Closed / All filter, a repo filter, and assignment to Optio, one issue
 * or all unassigned ones.
 */
internal class InboxViewModel(private val api: ApiClient) : ViewModel() {
    data class Filter(
        /** "" = all repos. */
        val repoId: String = "",
        /** `open` / `closed` / `all`. */
        val state: String = "open",
    )

    private val _issues = MutableStateFlow<LoadState<List<IssueRow>>>(LoadState.Idle)
    val issues: StateFlow<LoadState<List<IssueRow>>> = _issues.asStateFlow()

    private val _repos = MutableStateFlow<List<RepoSummary>>(emptyList())
    val repos: StateFlow<List<RepoSummary>> = _repos.asStateFlow()

    private val _filter = MutableStateFlow(Filter())
    val filter: StateFlow<Filter> = _filter.asStateFlow()

    private val _bulkBusy = MutableStateFlow(false)
    val bulkBusy: StateFlow<Boolean> = _bulkBusy.asStateFlow()

    private val _events = Channel<ScreenEvent>(Channel.BUFFERED)
    val events: Flow<ScreenEvent> = _events.receiveAsFlow()

    private var loadJob: Job? = null

    init {
        viewModelScope.launch { IssueAssignments.events.collect { markAssigned(it.identity, it.taskId) } }
    }

    /** Issues Optio can take on: GitHub / GitLab issues in a configured repo with no task yet. */
    fun unassigned(): List<IssueRow> = _issues.value.value.orEmpty().filter { it.isAssignable }

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { fetch() }
    }

    suspend fun reload() {
        loadJob?.cancel()
        fetch()
    }

    private suspend fun fetch() {
        val filter = _filter.value
        if (_repos.value.isEmpty()) _repos.value = runCatching { api.listRepoSummaries() }.getOrDefault(emptyList())
        _issues.load {
            api.listIssues(
                repoId = filter.repoId.ifEmpty { null },
                state = filter.state.takeUnless { it == "open" },
            )
        }
    }

    fun setState(state: String) {
        if (state == _filter.value.state) return
        _filter.update { it.copy(state = state) }
        refresh()
    }

    fun setRepo(repoId: String) {
        if (repoId == _filter.value.repoId) return
        _filter.update { it.copy(repoId = repoId) }
        refresh()
    }

    /** Assigns one issue with the repo's default agent (the row's quick action). */
    fun assign(issue: IssueRow) {
        val number = issue.numberInt ?: return
        val repoId = issue.repo?.id ?: return
        viewModelScope.launch {
            try {
                val task = api.assignIssue(number, repoId, issue.title, issue.body.orEmpty())
                markAssigned(issue.identity, task.id)
                _events.send(ScreenEvent.Toast("Assigned ${issue.numberText} to Optio"))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _events.send(ScreenEvent.Failure(e))
            }
        }
    }

    /** "Assign all": every unassigned issue in turn; failures are skipped and counted. */
    fun assignAll() {
        if (_bulkBusy.value) return
        viewModelScope.launch {
            _bulkBusy.value = true
            val targets = unassigned()
            var assigned = 0
            for (issue in targets) {
                val number = issue.numberInt ?: continue
                val repoId = issue.repo?.id ?: continue
                try {
                    val task = api.assignIssue(number, repoId, issue.title, issue.body.orEmpty())
                    markAssigned(issue.identity, task.id)
                    assigned++
                } catch (e: CancellationException) {
                    throw e
                } catch (_: Exception) {
                    // Skipped; the count says how many went through.
                }
            }
            _bulkBusy.value = false
            _events.send(ScreenEvent.Toast("Assigned $assigned of ${counted(targets.size, "issue")}"))
        }
    }

    /** Marks an issue as taken on locally (iOS `markAssigned`): queued task, `optio` label. */
    fun markAssigned(identity: String, taskId: String?) {
        _issues.update { state ->
            val list = state.value ?: return@update state
            val updated = list.map { issue ->
                if (issue.identity != identity) {
                    issue
                } else {
                    issue.copy(
                        optioTask = IssueRow.OptioTaskRef(taskId = taskId, state = "queued"),
                        labels = issue.labels.orEmpty().let { if ("optio" in it) it else it + "optio" },
                    )
                }
            }
            when (state) {
                is LoadState.Loaded -> LoadState.Loaded(updated)
                is LoadState.Loading -> LoadState.Loading(updated)
                is LoadState.Failed -> LoadState.Failed(state.error, updated)
                LoadState.Idle -> state
            }
        }
    }
}
