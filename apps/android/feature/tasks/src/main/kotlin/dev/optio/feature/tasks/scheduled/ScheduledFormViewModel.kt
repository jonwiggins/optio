package dev.optio.feature.tasks.scheduled

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.tasks.data.RunPromptTemplateRow
import dev.optio.feature.tasks.data.RunRepoRow
import dev.optio.feature.tasks.data.TaskConfigRow
import dev.optio.feature.tasks.data.createTaskConfig
import dev.optio.feature.tasks.data.getTaskConfig
import dev.optio.feature.tasks.data.runListPromptTemplates
import dev.optio.feature.tasks.data.runListRepos
import dev.optio.feature.tasks.data.updateTaskConfig
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** The scheduled blueprint form's answers (iOS `TaskConfigFormSheet`'s state). */
data class ScheduledDraft(
    val name: String = "",
    val description: String = "",
    val title: String = "",
    val prompt: String = "",
    val repoUrl: String = "",
    val branch: String = "main",
    /** "" = the repo's default agent. */
    val agentType: String = "",
    /** "" = no prompt template. */
    val templateId: String = "",
    val priority: Int = 100,
    val maxRetries: Int = 3,
    val enabled: Boolean = true,
    val original: TaskConfigRow? = null,
) {
    val isEdit: Boolean get() = original != null

    val canSubmit: Boolean
        get() = name.isNotBlank() && title.isNotBlank() && prompt.isNotBlank() && repoUrl.isNotEmpty()

    /** `POST /api/task-configs` (the create schema takes no nulls: unset fields are omitted). */
    fun createBody(): Map<String, Any?> = linkedMapOf<String, Any?>(
        "name" to name.trim(),
        "title" to title,
        "prompt" to prompt,
        "repoUrl" to repoUrl,
        "repoBranch" to branch.trim().ifEmpty { "main" },
        "maxRetries" to maxRetries,
        "priority" to priority,
        "enabled" to enabled,
    ).apply {
        description.trim().takeIf { it.isNotEmpty() }?.let { put("description", it) }
        templateId.takeIf { it.isNotEmpty() }?.let { put("promptTemplateId", it) }
        agentType.takeIf { it.isNotEmpty() }?.let { put("agentType", it) }
    }

    /** `PATCH /api/task-configs/:id`, with explicit nulls for what the user cleared. */
    fun updateBody(): Map<String, Any?> = linkedMapOf(
        "name" to name.trim(),
        "description" to description.trim().ifEmpty { null },
        "title" to title,
        "prompt" to prompt,
        "promptTemplateId" to templateId.ifEmpty { null },
        "repoUrl" to repoUrl,
        "repoBranch" to branch.trim().ifEmpty { "main" },
        "agentType" to agentType.ifEmpty { null },
        "maxRetries" to maxRetries,
        "priority" to priority,
        "enabled" to enabled,
    )

    companion object {
        fun of(c: TaskConfigRow): ScheduledDraft = ScheduledDraft(
            name = c.name,
            description = c.description.orEmpty(),
            title = c.title,
            prompt = c.prompt,
            repoUrl = c.repoUrl,
            branch = c.repoBranch ?: "main",
            agentType = c.agentType.orEmpty(),
            templateId = c.promptTemplateId.orEmpty(),
            priority = c.priority ?: 100,
            maxRetries = c.maxRetries ?: 3,
            enabled = c.enabled,
            original = c,
        )
    }
}

/** Create / edit a scheduled blueprint (iOS `TaskConfigFormSheet`), with the repo and prompt pickers. */
class ScheduledFormViewModel(
    private val api: ApiClient,
    private val configId: String?,
) : ViewModel() {
    private val _loading = MutableStateFlow<LoadState<Unit>>(LoadState.Idle)
    val loading: StateFlow<LoadState<Unit>> = _loading.asStateFlow()

    private val _draft = MutableStateFlow(ScheduledDraft())
    val draft: StateFlow<ScheduledDraft> = _draft.asStateFlow()

    private val _repos = MutableStateFlow<List<RunRepoRow>>(emptyList())
    val repos: StateFlow<List<RunRepoRow>> = _repos.asStateFlow()

    private val _templates = MutableStateFlow<List<RunPromptTemplateRow>>(emptyList())
    val templates: StateFlow<List<RunPromptTemplateRow>> = _templates.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    fun load() {
        if (_loading.value is LoadState.Loaded) return
        viewModelScope.launch {
            _loading.load {
                if (configId != null) _draft.value = ScheduledDraft.of(api.getTaskConfig(configId))
            }
            // The pickers degrade to empty (iOS `try?`).
            _repos.value = runCatchingNonCancel { api.runListRepos() }.orEmpty()
            val first = _repos.value.firstOrNull()
            if (_draft.value.repoUrl.isEmpty() && first != null) {
                _draft.update { it.copy(repoUrl = first.repoUrl, branch = first.defaultBranch ?: "main") }
            }
            _templates.value = runCatchingNonCancel { api.runListPromptTemplates("task") }.orEmpty()
        }
    }

    fun update(transform: (ScheduledDraft) -> ScheduledDraft) = _draft.update(transform)

    /** Picks a repo; a new blueprint takes the repo's default branch (iOS `onChange(of: repoUrl)`). */
    fun selectRepo(url: String) {
        val repo = _repos.value.firstOrNull { it.repoUrl == url }
        _draft.update { d ->
            if (d.isEdit || repo == null) d.copy(repoUrl = url) else d.copy(repoUrl = url, branch = repo.defaultBranch ?: "main")
        }
    }

    /** Picks a prompt template; its text replaces the prompt (iOS `onChange(of: templateId)`). */
    fun selectTemplate(id: String) {
        val template = _templates.value.firstOrNull { it.id == id }
        _draft.update { d -> if (template != null) d.copy(templateId = id, prompt = template.template) else d.copy(templateId = id) }
    }

    fun save(onSaved: (TaskConfigRow) -> Unit) {
        val d = _draft.value
        if (!d.canSubmit || _saving.value) return
        viewModelScope.launch {
            _saving.value = true
            _error.value = null
            try {
                val saved = if (d.original != null) api.updateTaskConfig(d.original.id, d.updateBody()) else api.createTaskConfig(d.createBody())
                onSaved(saved)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _error.value = e
            } finally {
                _saving.value = false
            }
        }
    }

    private suspend fun <T> runCatchingNonCancel(block: suspend () -> T): T? = try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
}
