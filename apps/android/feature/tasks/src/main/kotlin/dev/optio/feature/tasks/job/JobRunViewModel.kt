package dev.optio.feature.tasks.job

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.JobRun
import dev.optio.feature.tasks.data.cancelJobRun
import dev.optio.feature.tasks.data.getJob
import dev.optio.feature.tasks.data.getJobRun
import dev.optio.feature.tasks.data.retryJobRun
import dev.optio.feature.tasks.logs.RunLogStream
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/**
 * One Job run (iOS `JobRunDetailView` + `JobRunDetailModel`): the run, its job's name, the live log
 * (REST + `/ws/workflow-runs/:id/logs`) and Cancel / Retry.
 */
class JobRunViewModel(
    private val api: ApiClient,
    val jobId: String,
    val runId: String,
    socketFactory: ((path: String) -> WebSocketClient)? = null,
) : ViewModel() {
    private val _state = MutableStateFlow<LoadState<JobRun>>(LoadState.Idle)
    val state: StateFlow<LoadState<JobRun>> = _state.asStateFlow()

    private val _jobName = MutableStateFlow<String?>(null)

    /** The job's name, for the title (fetched once). */
    val jobName: StateFlow<String?> = _jobName.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages: Flow<UiMessage> = _messages.receiveAsFlow()

    val logs = RunLogStream(api, runId, viewModelScope, socketFactory ?: { api.webSocket(it) })

    private var loadJob: Job? = null
    private var nameJob: Job? = null

    init {
        viewModelScope.launch { logs.stateChanges.collect { refresh() } }
    }

    /** Loads the run; a failure shows only while there's no run on screen (iOS). */
    fun load() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch {
            if (_state.value.value == null) _state.value = LoadState.Loading(null)
            loadRun()
        }
        loadJobName()
    }

    /** A quiet refetch (polling while active, a state-change frame). */
    fun refresh() {
        if (loadJob?.isActive == true) return
        loadJob = viewModelScope.launch { loadRun() }
    }

    private suspend fun loadRun() {
        try {
            _state.value = LoadState.Loaded(api.getJobRun(runId))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (_state.value.value == null) _state.value = LoadState.Failed(e)
        }
    }

    /** The job's name for the title, fetched once (iOS: `if jobName == nil`). */
    private fun loadJobName() {
        if (_jobName.value != null || nameJob?.isActive == true) return
        nameJob = viewModelScope.launch {
            _jobName.value = try {
                api.getJob(jobId).name
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        }
    }

    private fun act(op: suspend () -> JobRun) {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            try {
                _state.value = LoadState.Loaded(op())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _messages.trySend(UiMessage.Failure(e))
            } finally {
                _busy.value = false
            }
        }
    }

    fun retry() = act { api.retryJobRun(runId) }

    fun cancel() = act { api.cancelJobRun(runId) }

    override fun onCleared() {
        logs.stop()
    }
}
