package dev.optio.feature.tasks.job

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.JobRun
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerOwner
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.data.cloneJob
import dev.optio.feature.tasks.data.createTrigger
import dev.optio.feature.tasks.data.deleteJob
import dev.optio.feature.tasks.data.deleteTrigger
import dev.optio.feature.tasks.data.getJob
import dev.optio.feature.tasks.data.listJobRuns
import dev.optio.feature.tasks.data.listTriggers
import dev.optio.feature.tasks.data.runJob
import dev.optio.feature.tasks.data.setJobEnabled
import dev.optio.feature.tasks.data.updateTrigger
import kotlin.coroutines.cancellation.CancellationException
import kotlin.math.roundToInt
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement

/** What the job detail shows (iOS `JobDetailModel`). */
data class JobDetail(
    val job: JobSummary,
    val runs: List<JobRun> = emptyList(),
    val triggers: List<TriggerRow> = emptyList(),
) {
    val activeRunCount: Int get() = runs.count { it.isActive }
    val hasActiveRuns: Boolean get() = runs.any { it.isActive }

    /** Completed ÷ all runs, rounded ("67%"); "—" with no runs. */
    val successRateText: String
        get() {
            if (runs.isEmpty()) return "—"
            val completed = runs.count { it.state == "completed" }
            return "${(completed.toDouble() / runs.size * 100).roundToInt()}%"
        }

    fun runs(filter: RunFilter): List<JobRun> = when (filter) {
        RunFilter.ALL -> runs
        RunFilter.RUNNING -> runs.filter { it.isActive }
        RunFilter.COMPLETED -> runs.filter { it.state == "completed" }
        RunFilter.FAILED -> runs.filter { it.state == "failed" }
    }
}

/** The runs list's filter chips. */
enum class RunFilter(val word: String) { ALL("all"), RUNNING("running"), COMPLETED("completed"), FAILED("failed") }

/**
 * The job detail (iOS `JobDetailView` + `JobDetailModel`): the job with its runs and triggers, and
 * Run / Duplicate / Enable-Disable / Delete plus trigger toggles, adds and deletes.
 */
class JobDetailViewModel(
    private val api: ApiClient,
    val jobId: String,
) : ViewModel() {
    private val _state = MutableStateFlow<LoadState<JobDetail>>(LoadState.Idle)
    val state: StateFlow<LoadState<JobDetail>> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages: Flow<UiMessage> = _messages.receiveAsFlow()

    private var refreshJob: Job? = null

    fun load() {
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch { _state.load { fetch() } }
    }

    /** A quiet refetch (polling while runs are active, coming back to the screen). */
    fun refresh() {
        if (_state.value.value == null) return load()
        if (refreshJob?.isActive == true) return
        refreshJob = viewModelScope.launch { refreshNow() }
    }

    private suspend fun refreshNow(reportErrors: Boolean = false) {
        try {
            _state.value = LoadState.Loaded(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (reportErrors) _messages.trySend(UiMessage.Failure(e))
        }
    }

    /** The job and its runs are required; triggers degrade to none (iOS `load`). */
    private suspend fun fetch(): JobDetail = coroutineScope {
        val job = async { api.getJob(jobId) }
        val runs = async { api.listJobRuns(jobId) }
        val triggers = async { runCatching { api.listTriggers(TriggerOwner.JOB, jobId) }.getOrDefault(emptyList()) }
        JobDetail(job.await(), runs.await(), triggers.await())
    }

    private fun act(op: suspend () -> String?) {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            try {
                op()?.let { _messages.trySend(UiMessage.Success(it)) }
                refreshNow()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.trySend(UiMessage.Failure(e))
            } finally {
                _busy.value = false
            }
        }
    }

    fun toggleEnabled() {
        val job = _state.value.value?.job ?: return
        act {
            api.setJobEnabled(jobId, !job.isEnabled)
            if (job.isEnabled) "Job disabled" else "Job enabled"
        }
    }

    fun duplicate() = act { "Duplicated as ${api.cloneJob(jobId).name}" }

    /** Deletes the job and its runs, then leaves the screen. */
    fun delete() {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            try {
                api.deleteJob(jobId)
                _messages.trySend(UiMessage.Success("Job deleted"))
                _messages.trySend(UiMessage.Close)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.trySend(UiMessage.Failure(e))
            } finally {
                _busy.value = false
            }
        }
    }

    /** The Run Job sheet: starts a run; throws so the sheet shows the error in place. */
    suspend fun runJob(params: Map<String, JsonElement>?): JobRun {
        val run = api.runJob(jobId, params)
        _messages.trySend(UiMessage.Success("Run started"))
        refreshNow()
        return run
    }

    fun setTriggerEnabled(trigger: TriggerRow, enabled: Boolean) = act {
        api.updateTrigger(TriggerOwner.JOB, jobId, trigger.id, enabled = enabled)
        null
    }

    fun deleteTrigger(trigger: TriggerRow) = act {
        api.deleteTrigger(TriggerOwner.JOB, jobId, trigger.id)
        "Trigger deleted"
    }

    /** The Add trigger sheet; throws so the sheet shows the error in place. */
    suspend fun addTrigger(draft: TriggerDraft) {
        api.createTrigger(TriggerOwner.JOB, jobId, draft.type.raw, draft.submitConfig(), draft.enabled)
        _messages.trySend(UiMessage.Success("Trigger added"))
        refreshNow()
    }
}
