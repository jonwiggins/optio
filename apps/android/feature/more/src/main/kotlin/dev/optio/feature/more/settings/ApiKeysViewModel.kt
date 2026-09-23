package dev.optio.feature.more.settings

import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.more.api.ApiKeyRow
import dev.optio.feature.more.api.CreatedApiKey
import dev.optio.feature.more.api.createApiKey
import dev.optio.feature.more.api.listApiKeys
import dev.optio.feature.more.api.revokeApiKey
import dev.optio.feature.more.ui.NoticeViewModel
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Personal access tokens (iOS `ApiKeysView` + `CreateApiKeySheet`). A new token is held in
 * [created] only until the sheet's Done ([finishCreate]): it is the one time the whole token
 * exists on this side, so it survives rotation (ViewModel) but is never persisted.
 */
class ApiKeysViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<List<ApiKeyRow>>>(LoadState.Idle)
    val state: StateFlow<LoadState<List<ApiKeyRow>>> = _state.asStateFlow()

    private val _created = MutableStateFlow<CreatedApiKey?>(null)

    /** The token just created, shown once in the sheet; null otherwise. */
    val created: StateFlow<CreatedApiKey?> = _created.asStateFlow()

    private val _creating = MutableStateFlow(false)
    val creating: StateFlow<Boolean> = _creating.asStateFlow()

    private var loadJob: Job? = null

    /** The PAT this app signs in with: the row whose prefix it starts with is "this app". */
    val currentToken: String?
        get() = api.token

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { api.listApiKeys() }
    }

    /** Creates a token named [name] ([defaultName] when blank), expiring at [expiresAt]. */
    fun create(
        name: String,
        defaultName: String,
        expiresAt: Instant?,
    ) {
        if (_creating.value) return
        _creating.value = true
        viewModelScope.launch {
            try {
                _created.value = api.createApiKey(name.trim().ifEmpty { defaultName }, expiresAt)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _creating.value = false
            }
        }
    }

    /** The sheet's Done: forget the token and reload the list. */
    fun finishCreate() {
        _created.value = null
        refresh()
    }

    fun revoke(key: ApiKeyRow) {
        viewModelScope.launch {
            try {
                api.revokeApiKey(key.id)
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }
}
