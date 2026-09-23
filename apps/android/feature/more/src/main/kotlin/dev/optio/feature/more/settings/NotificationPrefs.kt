package dev.optio.feature.more.settings

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Info
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.api.NotificationPref
import dev.optio.feature.more.api.getNotificationPreferences
import dev.optio.feature.more.api.updateNotificationPreferences
import dev.optio.feature.more.ui.AuthDisabledState
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.NoticeViewModel
import dev.optio.feature.more.ui.SwitchRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** One preference key with its copy. */
data class NotificationEvent(
    val key: String,
    val title: String,
    val description: String,
)

/**
 * The per-user preference keys (`/api/notifications/preferences`). [task] are the web's and iOS's
 * seven (same copy). [native] gate the native pushes (APNs / FCM, `docs/android-push.md`): Local
 * needs-you and exits, hosts going offline, agent replies and failures; they are listed only when
 * the server returns them (older servers don't have them).
 */
object NotificationEvents {
    val task: List<NotificationEvent> = listOf(
        NotificationEvent("task.pr_opened", "PR opened", "When a task you created opens a pull request"),
        NotificationEvent("task.completed", "Task completed", "When your task merges successfully"),
        NotificationEvent("task.failed", "Task failed", "When your task fails"),
        NotificationEvent("task.needs_attention", "Needs attention", "When a task needs your input (review changes, CI failing, etc.)"),
        NotificationEvent("task.stalled", "Task stalled", "When a task appears to be stuck"),
        NotificationEvent("task.review_requested", "Review requested", "When someone requests a review on your PR"),
        NotificationEvent("task.commented", "New comment", "When someone comments on your task"),
    )

    val native: List<NotificationEvent> = listOf(
        NotificationEvent("local.needs_you", "Terminal needs you", "When an agent on your machine waits for you, or an automated terminal exits"),
        NotificationEvent("local.host_offline", "Machine offline", "When a machine goes offline with agents running"),
        NotificationEvent("agent.turn_completed", "Agent replied", "When an agent answers your message"),
        NotificationEvent("agent.failed", "Agent failed", "When an agent stops after repeated failures"),
    )
}

/** Notification toggles (iOS `NotificationPreferencesView`): optimistic, reverted on failure. */
class NotificationPrefsViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<Map<String, NotificationPref>>>(LoadState.Idle)
    val state: StateFlow<LoadState<Map<String, NotificationPref>>> = _state.asStateFlow()

    private var loadJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { api.getNotificationPreferences() }
    }

    /** Flips [event] at once and saves it; the server's merged map replaces ours on success. */
    fun set(
        event: String,
        on: Boolean,
    ) {
        val before = _state.value.value ?: return
        _state.value = LoadState.Loaded(before + (event to NotificationPref(on)))
        viewModelScope.launch {
            try {
                val saved = api.updateNotificationPreferences(mapOf(event to NotificationPref(on)))
                _state.value = LoadState.Loaded(saved)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                val current = _state.value.value ?: before
                _state.value = LoadState.Loaded(before[event]?.let { current + (event to it) } ?: (current - event))
                fail(e)
            }
        }
    }
}

/** `NotificationPrefsRoute`. */
@Composable
fun NotificationPrefsScreen() {
    val api = LocalApiClient.current
    val authDisabled = LocalCurrentUser.current?.authDisabled == true
    val viewModel = viewModel { NotificationPrefsViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel, authDisabled) { if (!authDisabled) viewModel.load() }
    MoreScaffold("Notifications") { padding ->
        NotificationPrefsContent(
            state = state,
            authDisabled = authDisabled,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onToggle = viewModel::set,
        )
    }
}

/** The toggles, stateless. */
@Composable
fun NotificationPrefsContent(
    state: LoadState<Map<String, NotificationPref>>,
    authDisabled: Boolean,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onToggle: (String, Boolean) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (authDisabled) {
        Box(modifier.fillMaxSize().padding(contentPadding)) { AuthDisabledState("notification preferences") }
        return
    }
    Loadable(state = state, onRetry = onRetry, what = "notification preferences", contentPadding = contentPadding, modifier = modifier) { prefs ->
        LazyColumn(Modifier.fillMaxSize().testTag("notification-prefs"), contentPadding = contentPadding) {
            item(key = "note") {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.l + Spacing.l, vertical = Spacing.m),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    verticalAlignment = Alignment.Top,
                ) {
                    Icon(Icons.Outlined.Info, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(18.dp))
                    Text(
                        "Choose what Optio notifies you about. The same choices apply to your browsers, this phone and your other devices.",
                        style = OptioTheme.type.footnote,
                        color = OptioTheme.colors.secondaryLabel,
                    )
                }
            }
            groupedItem("events", header = "Notification events") {
                EventToggles(NotificationEvents.task, prefs, onToggle)
            }
            val native = NotificationEvents.native.filter { it.key in prefs }
            if (native.isNotEmpty()) {
                groupedItem("native", header = "Machines and agents") {
                    EventToggles(native, prefs, onToggle)
                }
            }
            bottomSpacer()
        }
    }
}

@Composable
private fun EventToggles(
    events: List<NotificationEvent>,
    prefs: Map<String, NotificationPref>,
    onToggle: (String, Boolean) -> Unit,
) {
    events.forEachIndexed { index, event ->
        if (index > 0) InsetDivider()
        SwitchRow(
            title = event.title,
            subtitle = event.description,
            checked = prefs[event.key]?.push ?: false,
            onCheckedChange = { onToggle(event.key, it) },
            modifier = Modifier.testTag("pref-${event.key}"),
        )
    }
}
