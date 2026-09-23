package dev.optio.feature.more.secrets

import androidx.lifecycle.viewModelScope
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.RepoRef
import dev.optio.feature.more.api.SecretCreateResult
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.api.deleteSecret
import dev.optio.feature.more.api.listRepoRefs
import dev.optio.feature.more.api.listSecrets
import dev.optio.feature.more.api.upsertSecret
import dev.optio.feature.more.ui.NoticeViewModel
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** The secrets list and the repos a secret can be scoped to. */
data class SecretsData(
    val secrets: List<SecretRow>,
    val repos: List<RepoRef>,
) {
    /** iOS `SecretsModel.scopeLabel`: Global, User-only, or the repo's name. */
    fun scopeLabel(scope: String?): String = when (scope) {
        null, SecretRow.SCOPE_GLOBAL -> "Global"
        SecretRow.SCOPE_USER -> "User-only"
        else -> repos.firstOrNull { it.repoUrl == scope }?.displayName ?: scope
    }
}

/**
 * Secret names and scopes (iOS `SecretsModel`). Values are write-only: never fetched, shown,
 * stored in UI state that outlives the form, or logged.
 */
class SecretsViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<SecretsData>>(LoadState.Idle)
    val state: StateFlow<LoadState<SecretsData>> = _state.asStateFlow()

    private val _scopeFilter = MutableStateFlow(FILTER_ALL)

    /** "all", "global", "user" or a repo URL. */
    val scopeFilter: StateFlow<String> = _scopeFilter.asStateFlow()

    private val _saving = MutableStateFlow(false)
    val saving: StateFlow<Boolean> = _saving.asStateFlow()

    private var loadJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    fun setFilter(filter: String) {
        if (filter == _scopeFilter.value) return
        _scopeFilter.value = filter
        refresh()
    }

    suspend fun load() {
        val filter = _scopeFilter.value
        _state.load {
            coroutineScope {
                val repos = async {
                    try {
                        api.listRepoRefs()
                    } catch (e: CancellationException) {
                        throw e
                    } catch (_: ApiError) {
                        _state.value.value?.repos.orEmpty()
                    }
                }
                val secrets = api.listSecrets(if (filter == FILTER_ALL) null else filter)
                SecretsData(normalizeSecrets(secrets, filter), repos.await())
            }
        }
    }

    /** Creates or replaces [name] in [scope]; [onSaved] closes the form (and drops the value). */
    fun save(
        name: String,
        value: String,
        scope: String,
        onSaved: () -> Unit,
    ) {
        if (_saving.value) return
        _saving.value = true
        viewModelScope.launch {
            try {
                val result = api.upsertSecret(name.trim(), value, scope)
                onSaved()
                load()
                val (text, tone) = saveNotice(result)
                notify(text, tone)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            } finally {
                _saving.value = false
            }
        }
    }

    fun delete(secret: SecretRow) {
        viewModelScope.launch {
            try {
                api.deleteSecret(secret.name, secret.scope)
                load()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    companion object {
        const val FILTER_ALL = "all"
    }
}

/**
 * The list as shown: one row per secret, only the filtered scope. The server's list repeats the
 * caller's user-scoped secrets (once from the workspace query, once from the user query) and
 * answers `?scope=global` with the user rows appended, so both are fixed up here.
 */
internal fun normalizeSecrets(
    rows: List<SecretRow>,
    filter: String,
): List<SecretRow> = rows
    .distinctBy { it.listId }
    .filter { filter == SecretsViewModel.FILTER_ALL || (it.scope ?: SecretRow.SCOPE_GLOBAL) == filter }

/** iOS copy after a save: a failed validation still saved the value. */
internal fun saveNotice(result: SecretCreateResult): Pair<String, Tone> {
    val validation = result.validation
    return if (validation != null && !validation.valid) {
        "Saved, but validation failed: ${validation.error ?: "token rejected"}" to Tone.ACCENT
    } else {
        "${result.name} has been encrypted and stored." to Tone.SUCCESS
    }
}
