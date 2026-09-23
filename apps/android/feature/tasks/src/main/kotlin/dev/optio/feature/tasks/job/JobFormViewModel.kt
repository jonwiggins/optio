package dev.optio.feature.tasks.job

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerOwner
import dev.optio.feature.tasks.data.createJob
import dev.optio.feature.tasks.data.createTrigger
import dev.optio.feature.tasks.data.deleteTrigger
import dev.optio.feature.tasks.data.getJob
import dev.optio.feature.tasks.data.listTriggers
import dev.optio.feature.tasks.data.updateJob
import dev.optio.feature.tasks.data.updateTrigger
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** How a save ended: the job, and whether it was just created. */
data class JobSaved(val job: JobSummary, val created: Boolean)

/**
 * The Job create / edit form (iOS `JobFormView`). Editing loads the job and its triggers first.
 * Saving writes the job, then diffs the triggers (a type change is delete + create). If a trigger
 * step fails after a new job was created, the form switches to editing that job, so saving again
 * never creates a second one.
 */
class JobFormViewModel(
    private val api: ApiClient,
    jobId: String?,
) : ViewModel() {
    private var jobId: String? = jobId

    private val _loading = MutableStateFlow<LoadState<Unit>>(if (jobId == null) LoadState.Loaded(Unit) else LoadState.Idle)

    /** Editing: the job loading; creating: loaded at once. */
    val loading: StateFlow<LoadState<Unit>> = _loading.asStateFlow()

    private val _draft = MutableStateFlow(JobDraft())
    val draft: StateFlow<JobDraft> = _draft.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)

    /** Why the last save failed (shown in the form). */
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    /** True when a save created the job (a later retry edits it). */
    private var created = false

    fun load() {
        val id = jobId ?: return
        if (_loading.value is LoadState.Loaded) return
        viewModelScope.launch {
            _loading.load {
                coroutineScope {
                    val job = async { api.getJob(id) }
                    val triggers = async { api.listTriggers(TriggerOwner.JOB, id) }
                    _draft.value = JobDraft.of(job.await(), triggers.await())
                }
            }
        }
    }

    fun update(transform: (JobDraft) -> JobDraft) = _draft.update(transform)

    /** Saves; calls [onSaved] when the job and every trigger step went through. */
    fun save(onSaved: (JobSaved) -> Unit) {
        val start = _draft.value
        if (!start.canSave || _saving.value) return
        viewModelScope.launch {
            _saving.value = true
            _error.value = null
            try {
                val id = jobId
                val job = if (id == null) {
                    api.createJob(start.createBody()).also {
                        jobId = it.id
                        created = true
                        // From here on the form edits the job it just made.
                        _draft.update { d -> d.copy(original = it) }
                    }
                } else {
                    api.updateJob(id, start.updateBody())
                }
                syncTriggers(job.id)
                onSaved(JobSaved(job, created))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e
            } finally {
                _saving.value = false
            }
        }
    }

    /** Applies each trigger draft's change, recording progress so a retry doesn't repeat a step. */
    private suspend fun syncTriggers(jobId: String) {
        for (draft in _draft.value.triggers) {
            when (draft.change) {
                TriggerDraft.Change.NONE -> Unit
                TriggerDraft.Change.DELETE -> {
                    api.deleteTrigger(TriggerOwner.JOB, jobId, draft.existingId!!)
                    _draft.update { d -> d.copy(triggers = d.triggers.filter { it.key != draft.key }) }
                }
                TriggerDraft.Change.UPDATE -> {
                    val row = api.updateTrigger(TriggerOwner.JOB, jobId, draft.existingId!!, config = draft.submitConfig(), enabled = draft.enabled)
                    _draft.update { d -> d.withTrigger(draft.key) { TriggerDraft.of(row).copy(key = draft.key) } }
                }
                TriggerDraft.Change.REPLACE -> {
                    // The PATCH body has no `type`: a type change is delete + create.
                    api.deleteTrigger(TriggerOwner.JOB, jobId, draft.existingId!!)
                    _draft.update { d -> d.withTrigger(draft.key) { it.copy(existingId = null, originalType = null, originalConfig = null, originalEnabled = null) } }
                    val row = api.createTrigger(TriggerOwner.JOB, jobId, draft.type.raw, draft.submitConfig(), draft.enabled)
                    _draft.update { d -> d.withTrigger(draft.key) { TriggerDraft.of(row).copy(key = draft.key) } }
                }
                TriggerDraft.Change.CREATE -> {
                    val row = api.createTrigger(TriggerOwner.JOB, jobId, draft.type.raw, draft.submitConfig(), draft.enabled)
                    _draft.update { d -> d.withTrigger(draft.key) { TriggerDraft.of(row).copy(key = draft.key) } }
                }
            }
        }
    }
}
