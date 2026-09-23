package dev.optio.feature.more.settings

import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.more.api.AuthProviders
import dev.optio.feature.more.api.ClaudeAuthStatus
import dev.optio.feature.more.api.claudeAuthStatus
import dev.optio.feature.more.api.listAuthProviders
import dev.optio.feature.more.api.refreshClaudeAuth
import dev.optio.feature.more.ui.NoticeViewModel
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * Settings (iOS `SettingsView`): the Claude token status agents use, the sign-in providers the
 * server has configured, and the admin-only credential cache refresh.
 */
class SettingsViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _claude = MutableStateFlow<LoadState<ClaudeAuthStatus.Subscription>>(LoadState.Idle)
    val claude: StateFlow<LoadState<ClaudeAuthStatus.Subscription>> = _claude.asStateFlow()

    private val _providers = MutableStateFlow<AuthProviders?>(null)

    /** Null until loaded (or when the route failed: iOS leaves the section on its defaults). */
    val providers: StateFlow<AuthProviders?> = _providers.asStateFlow()

    private val _refreshing = MutableStateFlow(false)
    val refreshing: StateFlow<Boolean> = _refreshing.asStateFlow()

    init {
        viewModelScope.launch { load() }
    }

    suspend fun load() {
        _claude.load { api.claudeAuthStatus().subscription }
        try {
            _providers.value = api.listAuthProviders()
        } catch (e: CancellationException) {
            throw e
        } catch (_: ApiError) {
            // Optional: the section keeps its last value.
        }
    }

    /** `POST /api/auth/refresh` (admins), then re-reads the status. */
    fun refreshClaude() {
        if (_refreshing.value) return
        _refreshing.value = true
        viewModelScope.launch {
            try {
                api.refreshClaudeAuth()
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _refreshing.value = false
            }
        }
    }
}
