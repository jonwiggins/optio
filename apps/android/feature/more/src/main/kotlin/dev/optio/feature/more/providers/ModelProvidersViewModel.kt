package dev.optio.feature.more.providers

import androidx.lifecycle.viewModelScope
import dev.optio.core.model.ModelProvider
import dev.optio.core.network.ApiClient
import dev.optio.core.network.createModelProvider
import dev.optio.core.network.deleteModelProvider
import dev.optio.core.network.listModelProviders
import dev.optio.core.network.updateModelProvider
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.more.ui.NoticeViewModel
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Settings › Model providers: the list, and create / edit / delete (credentials write-only). */
class ModelProvidersViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<List<ModelProvider>>>(LoadState.Idle)
    val state: StateFlow<LoadState<List<ModelProvider>>> = _state.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    fun refresh() {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { api.listModelProviders() }
    }

    /** Creates or updates [draft]; [onSaved] closes the editor (and drops the typed credentials). */
    fun save(draft: ModelProviderDraft, onSaved: () -> Unit) {
        if (_saving.value) return
        draft.problem()?.let { return fail(it) }
        _saving.value = true
        viewModelScope.launch {
            try {
                val id = draft.id
                val saved = if (id == null) api.createModelProvider(draft.body()) else api.updateModelProvider(id, draft.body())
                onSaved()
                load()
                notify("${saved.name} saved")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _saving.value = false
            }
        }
    }

    fun delete(provider: ModelProvider) {
        viewModelScope.launch {
            try {
                api.deleteModelProvider(provider.id)
                load()
                notify("${provider.name} deleted")
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }
}
