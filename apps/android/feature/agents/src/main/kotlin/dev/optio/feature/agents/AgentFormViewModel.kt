package dev.optio.feature.agents

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.PersistentAgent
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/**
 * The agent form (iOS `AgentFormSheet`): create when [agentId] is null, else edit that agent. Edit
 * loads the agent and seeds [draft] from it once; [save] POSTs or PATCHes and reports the saved row.
 */
class AgentFormViewModel(
    val agentId: String?,
    private val api: ApiClient,
) : ViewModel() {
    val isEditing: Boolean
        get() = agentId != null

    private val _agent = MutableStateFlow<LoadState<PersistentAgent?>>(if (agentId == null) LoadState.Loaded(null) else LoadState.Idle)

    /** The agent being edited (Loaded(null) when creating). */
    val agent: StateFlow<LoadState<PersistentAgent?>> = _agent.asStateFlow()

    private val _draft = MutableStateFlow(AgentFormDraft())
    val draft: StateFlow<AgentFormDraft> = _draft.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private val _error = MutableStateFlow<Throwable?>(null)

    /** The last save's failure (shown in the form, like iOS). */
    val error: StateFlow<Throwable?> = _error.asStateFlow()

    private var seeded = false

    init {
        if (agentId != null) load()
    }

    fun load() {
        val id = agentId ?: return
        viewModelScope.launch {
            val agent = _agent.load { api.getPersistentAgent(id).agent }
            if (agent != null && !seeded) {
                seeded = true
                _draft.value = AgentFormDraft.from(agent)
            }
        }
    }

    fun edit(change: (AgentFormDraft) -> AgentFormDraft) {
        _draft.update(change)
    }

    /** Creates or saves; the saved agent, or null when it failed ([error] says why). */
    suspend fun save(): PersistentAgent? {
        val draft = _draft.value
        if (_saving.value || !draft.isValid(isEditing)) return null
        _saving.value = true
        _error.value = null
        return try {
            if (agentId == null) api.createPersistentAgent(draft.createInput()) else api.updatePersistentAgent(agentId, draft.patch())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            _error.value = e
            null
        } finally {
            _saving.value = false
        }
    }
}
