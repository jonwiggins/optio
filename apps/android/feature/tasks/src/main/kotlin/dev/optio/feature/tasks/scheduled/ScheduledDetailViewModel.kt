package dev.optio.feature.tasks.scheduled

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.TaskConfigRow
import dev.optio.feature.tasks.data.TaskRow
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerOwner
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.data.createTrigger
import dev.optio.feature.tasks.data.deleteTaskConfig
import dev.optio.feature.tasks.data.deleteTrigger
import dev.optio.feature.tasks.data.getTaskConfig
import dev.optio.feature.tasks.data.listTriggers
import dev.optio.feature.tasks.data.runTaskConfig
import dev.optio.feature.tasks.data.setTaskConfigEnabled
import dev.optio.feature.tasks.data.taskConfigRuns
import dev.optio.feature.tasks.data.updateTrigger
import kotlin.coroutines.cancellation.CancellationException
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

/** What the scheduled blueprint's page shows (iOS `ScheduledDetailModel`). */
data class ScheduledDetail(
    val config: TaskConfigRow,
    val triggers: List<TriggerRow> = emptyList(),
    val runs: List<TaskRow> = emptyList(),
)

/**
 * A scheduled Task blueprint (iOS `ScheduledDetailView` + `ScheduledDetailModel`): its config,
 * triggers and prior runs, and Run now / Pause-Resume / Delete plus trigger toggles, adds and
 * deletes.
 */
class ScheduledDetailViewModel(
    private val api: ApiClient,
    val configId: String,
) : ViewModel() {
    private val _state = MutableStateFlow<LoadState<ScheduledDetail>>(LoadState.Idle)
    val state: StateFlow<LoadState<ScheduledDetail>> = _state.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val _messages = Channel<UiMessage>(Channel.BUFFERED)
    val messages: Flow<UiMessage> = _messages.receiveAsFlow()

    private var refreshJob: Job? = null

    fun load() {
        refreshJob?.cancel()
        refreshJob = viewModelScope.launch { _state.load { fetch() } }
    }

    fun refresh() {
        if (refreshJob?.isActive == true) return
        if (_state.value.value == null) return load()
        refreshJob = viewModelScope.launch { refreshNow() }
    }

    private suspend fun refreshNow() {
        try {
            _state.value = LoadState.Loaded(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
        }
    }

    /** The blueprint is required; triggers and runs degrade to empty (iOS `load`). */
    private suspend fun fetch(): ScheduledDetail = coroutineScope {
        val config = async { api.getTaskConfig(configId) }
        val triggers = async { runCatching { api.listTriggers(TriggerOwner.TASK_CONFIG, configId) }.getOrDefault(emptyList()) }
        val runs = async { runCatching { api.taskConfigRuns(configId) }.getOrDefault(emptyList()) }
        ScheduledDetail(config.await(), triggers.await(), runs.await())
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

    /** Spawns one task now ("Task queued: 3b8bf012"). */
    fun runNow() = act { "Task queued: ${api.runTaskConfig(configId).take(8)}" }

    /** Pause / Resume the blueprint. */
    fun toggleEnabled() {
        val config = _state.value.value?.config ?: return
        act {
            api.setTaskConfigEnabled(configId, !config.enabled)
            if (config.enabled) "Paused" else "Resumed"
        }
    }

    fun setTriggerEnabled(trigger: TriggerRow, enabled: Boolean) = act {
        api.updateTrigger(TriggerOwner.TASK_CONFIG, configId, trigger.id, enabled = enabled)
        null
    }

    fun deleteTrigger(trigger: TriggerRow) = act {
        api.deleteTrigger(TriggerOwner.TASK_CONFIG, configId, trigger.id)
        "Trigger deleted"
    }

    /** The Add trigger sheet; throws so the sheet shows the error in place. */
    suspend fun addTrigger(draft: TriggerDraft) {
        api.createTrigger(TriggerOwner.TASK_CONFIG, configId, draft.type.raw, draft.submitConfig(), draft.enabled)
        _messages.trySend(UiMessage.Success("Trigger added"))
        refreshNow()
    }

    /** Deletes the blueprint (and its triggers), then leaves the screen. */
    fun delete() {
        if (_busy.value) return
        viewModelScope.launch {
            _busy.value = true
            try {
                api.deleteTaskConfig(configId)
                _messages.trySend(UiMessage.Success("Deleted"))
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
}
