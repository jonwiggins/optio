package dev.optio.feature.glance.settings

import android.content.ActivityNotFoundException
import android.content.Context
import android.content.Intent
import android.os.Build
import android.provider.Settings
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushState
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.ServerPushState
import dev.optio.core.glance.WatchCopy
import dev.optio.core.model.WatchPhase
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.glance.GlanceRuntime
import dev.optio.feature.glance.refresh.GlanceWork
import dev.optio.feature.glance.watch.WatchNotifier
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch

/** Whether the Watch may be promoted to a Live Update (Android 16+). */
enum class PromotionState { UNSUPPORTED, ALLOWED, OFF }

/** Everything the Watch settings screen shows. */
data class WatchSettingsUiState(
    /** What the Watch shows now (null before the first check). */
    val watch: GlanceWatchState? = null,
    val watchShowing: Boolean = false,
    val push: PushState = PushState(),
    val servers: List<ServerProfile> = emptyList(),
    val activeServerId: String? = null,
    val promotion: PromotionState = PromotionState.UNSUPPORTED,
) {
    /** Every paired server gets pushes from its server (keep watching adds nothing). */
    val allServersPush: Boolean
        get() = servers.isNotEmpty() && servers.all { push.server(it.id)?.receivesPush == true }
}

/** What the screen's controls do. */
class WatchSettingsActions(
    val onBack: () -> Unit = {},
    val setKeepWatching: (Boolean) -> Unit = {},
    val checkNow: () -> Unit = {},
    val requestPermission: () -> Unit = {},
    val openNotificationSettings: () -> Unit = {},
    val openPromotionSettings: () -> Unit = {},
    val retryRegistration: () -> Unit = {},
)

/**
 * `WatchSettingsRoute`: the Watch (the ongoing notification), "Keep watching in the background",
 * the notification permission, and push delivery per server (the Android side of iOS
 * `NotificationsDevicesView`'s authorization and registration sections).
 */
@Composable
fun WatchSettingsScreen() {
    val context = LocalContext.current
    val navigator = LocalNavigator.current
    val scope = rememberCoroutineScope()
    val runtime = remember(context) { if (GlanceHost.isInstalled) GlanceRuntime.get(context) else null }
    val push = remember(context) { runtime?.status ?: PushStatus.get(context) }
    val pushState by push.state.collectAsStateWithLifecycle()
    val watch by (runtime?.watch?.display ?: MutableStateFlow(null)).collectAsStateWithLifecycle()
    val showing by (runtime?.watch?.showing ?: MutableStateFlow(false)).collectAsStateWithLifecycle()
    val keepWatching by (runtime?.keepWatching?.enabled ?: flowOf(false)).collectAsStateWithLifecycle(initialValue = pushState.keepWatching)
    val session = LocalSessionStore.current
    val servers by session.servers.collectAsStateWithLifecycle()
    val active by session.activeServer.collectAsStateWithLifecycle()
    val promotion = promotionState(context)

    // Back from the permission dialog or system settings: re-read what changed.
    LifecycleResumeEffect(push) {
        push.refreshPermission(context)
        onPauseOrDispose {}
    }
    val permissionLauncher =
        rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
            push.markPrompted(context)
        }

    val state =
        WatchSettingsUiState(
            watch = watch,
            watchShowing = showing,
            push = pushState.copy(keepWatching = keepWatching),
            servers = servers,
            activeServerId = active?.id,
            promotion = promotion,
        )
    WatchSettingsContent(
        state = state,
        actions =
            WatchSettingsActions(
                onBack = navigator::pop,
                setKeepWatching = { on -> scope.launch { runtime?.keepWatching?.set(on) } },
                checkNow = { GlanceWork.runNow(context) },
                requestPermission = {
                    if (NotificationPermission.isRuntime) permissionLauncher.launch(NotificationPermission.PERMISSION) else context.open(NotificationPermission.settingsIntent(context))
                },
                openNotificationSettings = { context.open(NotificationPermission.settingsIntent(context)) },
                openPromotionSettings = { context.open(promotionSettingsIntent(context)) },
                retryRegistration = { scope.launch { push.syncNow() } },
            ),
    )
}

/** The stateless body (screenshots render this). */
@Composable
fun WatchSettingsContent(
    state: WatchSettingsUiState,
    actions: WatchSettingsActions,
    modifier: Modifier = Modifier,
) {
    Scaffold(
        modifier = modifier.testTag("watch-settings"),
        containerColor = OptioTheme.colors.page,
        topBar = {
            TopAppBar(
                title = { Text("Watch & notifications") },
                navigationIcon = {
                    IconButton(onClick = actions.onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth(),
            contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.xl),
        ) {
            item(key = "watch") { WatchSection(state, actions) }
            item(key = "background") { BackgroundSection(state, actions) }
            item(key = "alerts") { AlertsSection(state, actions) }
            item(key = "push") { PushSection(state, actions) }
        }
    }
}

@Composable
private fun WatchSection(
    state: WatchSettingsUiState,
    actions: WatchSettingsActions,
) {
    val watch = state.watch
    GroupedSection(
        header = "Watch",
        footer =
            "An ongoing notification shows the session waiting on you, plus how many more, with Reply and " +
                "Later right on it. It appears when sessions run and ends two minutes after everything goes quiet.",
    ) {
        if (state.watchShowing && watch != null) {
            val head = watch.head
            OptioRow(
                title = WatchCopy.headline(watch),
                tone = tone(watch.phase),
                meta = head?.let { metaText(it.title, WatchCopy.statusLine(it)) } ?: metaText(WatchCopy.summaryLine(watch)),
                footer = WatchCopy.countsLine(watch).takeIf { it.isNotEmpty() }?.let { metaText(it) },
                modifier = Modifier.testTag("watch-status"),
            )
        } else {
            OptioRow(
                title = "Not showing",
                tone = Tone.IDLE,
                meta = metaText(if (watch?.phase == WatchPhase.DONE) WatchCopy.summaryLine(watch) else "Nothing is running or waiting on you"),
                modifier = Modifier.testTag("watch-status"),
            )
        }
        if (state.promotion != PromotionState.UNSUPPORTED) {
            InsetDivider()
            KeyValueRow(
                label = "Live Update",
                value = if (state.promotion == PromotionState.ALLOWED) "On" else "Off in system settings",
                onClick = actions.openPromotionSettings,
                modifier = Modifier.testTag("live-update"),
            )
        }
    }
}

@Composable
private fun BackgroundSection(
    state: WatchSettingsUiState,
    actions: WatchSettingsActions,
) {
    val push = state.push
    val now = rememberNow()
    val footer =
        when {
            state.allServersPush -> "Your server pushes updates to this phone, so you don't need this."
            else ->
                "Holds a live connection to your Optio server while Optio is closed, so the Watch and alerts " +
                    "update the moment something needs you. Uses a little more battery. Without it, Optio " +
                    "checks every 15 minutes."
        }
    GroupedSection(header = "Background", footer = footer) {
        OptioRow(
            title = "Keep watching in the background",
            meta = metaText(if (push.keepWatchingActive) "Watching now" else if (push.keepWatching) "Starts when Optio opens" else "Off"),
            trailingContent = {
                Switch(
                    checked = push.keepWatching,
                    onCheckedChange = actions.setKeepWatching,
                    enabled = state.servers.isNotEmpty(),
                    modifier = Modifier.testTag("keep-watching-switch"),
                )
            },
            onClick = { actions.setKeepWatching(!push.keepWatching) },
            modifier = Modifier.testTag("keep-watching"),
        )
        InsetDivider()
        OptioRow(
            title = "Background check",
            meta =
                metaText(
                    "Every 15 minutes",
                    push.lastPollAt?.let { "last ${it.relativeDescription(now)}" },
                ),
            footer = push.lastPollError?.let { metaText("Last check failed: $it") },
            footerTone = Tone.DANGER,
            trailingContent = {
                TextButton(onClick = actions.checkNow, modifier = Modifier.testTag("check-now")) { Text("Check now") }
            },
        )
    }
}

@Composable
private fun AlertsSection(
    state: WatchSettingsUiState,
    actions: WatchSettingsActions,
) {
    val permission = state.push.permission
    GroupedSection(
        header = "Alerts",
        footer =
            "Optio only alerts when something needs you: a terminal waiting on a reply, a task that stalled, " +
                "an agent that answered. Working and idle are silent.",
    ) {
        Row(
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
            horizontalArrangement = Arrangement.spacedBy(Spacing.m),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(
                permissionIcon(permission),
                contentDescription = null,
                tint = if (permission == NotificationPermissionState.GRANTED) OptioTheme.colors.accent else if (permission == NotificationPermissionState.DENIED) OptioTheme.colors.red else OptioTheme.colors.secondaryLabel,
                modifier = Modifier.size(22.dp),
            )
            Text(permission.label, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f).testTag("permission-state"))
            when (permission) {
                NotificationPermissionState.NOT_DETERMINED ->
                    TextButton(onClick = actions.requestPermission, modifier = Modifier.testTag("enable-notifications")) { Text("Enable") }
                NotificationPermissionState.DENIED ->
                    TextButton(onClick = actions.openNotificationSettings, modifier = Modifier.testTag("open-notification-settings")) { Text("Settings") }
                NotificationPermissionState.GRANTED -> Unit
            }
        }
        InsetDivider()
        KeyValueRow(
            label = "Choose which alerts ring",
            value = null,
            onClick = actions.openNotificationSettings,
            modifier = Modifier.testTag("alert-channels"),
        )
    }
}

@Composable
private fun PushSection(
    state: WatchSettingsUiState,
    actions: WatchSettingsActions,
) {
    val push = state.push
    val fcm = push.fcm
    val footer =
        when (fcm) {
            FcmAvailability.NotConfigured ->
                "Server push needs a build with Firebase (google-services.json). Everything else — the Watch, " +
                    "alerts from the background check, widgets — works without it."
            is FcmAvailability.Unavailable -> "Firebase couldn't issue a token: ${fcm.reason}"
            else -> "Each paired server sends this phone its alerts and Watch updates."
        }
    val needsRetry = push.servers.values.any { it.registration == PushRegistration.FAILED || it.registration == PushRegistration.UNSUPPORTED }
    GroupedSection(header = "Push delivery", footer = footer) {
        KeyValueRow(
            label = "Firebase Cloud Messaging",
            value =
                when (fcm) {
                    FcmAvailability.Available -> "Ready"
                    FcmAvailability.NotConfigured -> "Not in this build"
                    is FcmAvailability.Unavailable -> "Unavailable"
                    FcmAvailability.Unknown -> "Checking…"
                },
            modifier = Modifier.testTag("fcm-state"),
        )
        push.maskedToken?.let {
            InsetDivider()
            KeyValueRow(label = "Token", value = it, mono = true)
        }
        // Without Firebase no server can push here; one line (above) says so for all of them.
        if (fcm != FcmAvailability.NotConfigured) state.servers.forEach { server ->
            val row = push.server(server.id) ?: ServerPushState(server.id)
            InsetDivider()
            OptioRow(
                title = server.name + if (server.id == state.activeServerId && state.servers.size > 1) " (active)" else "",
                leading = { ServerDot(argb = server.color.argb) },
                meta = metaText(row.label(push)),
                footer = row.detail(push)?.let { metaText(it) },
                footerTone = if (row.registration == PushRegistration.FAILED) Tone.DANGER else null,
                modifier = Modifier.testTag("push-server-${server.id}"),
            )
        }
        if (needsRetry) {
            InsetDivider()
            Column(Modifier.padding(horizontal = Spacing.s)) {
                TextButton(onClick = actions.retryRegistration, modifier = Modifier.testTag("retry-registration")) { Text("Retry registration") }
            }
        }
    }
}

private fun tone(phase: WatchPhase): Tone =
    when (phase) {
        WatchPhase.WAITING -> Tone.ACCENT
        WatchPhase.WORKING -> Tone.WORKING
        else -> Tone.IDLE
    }

private fun permissionIcon(permission: NotificationPermissionState): ImageVector =
    when (permission) {
        NotificationPermissionState.GRANTED -> Icons.Outlined.NotificationsActive
        NotificationPermissionState.DENIED -> Icons.Outlined.NotificationsOff
        NotificationPermissionState.NOT_DETERMINED -> Icons.Outlined.Notifications
    }

private fun promotionState(context: Context): PromotionState =
    when {
        Build.VERSION.SDK_INT < 36 -> PromotionState.UNSUPPORTED
        WatchNotifier.canPromote(context) -> PromotionState.ALLOWED
        else -> PromotionState.OFF
    }

private fun promotionSettingsIntent(context: Context): Intent =
    if (Build.VERSION.SDK_INT >= 36) {
        Intent(Settings.ACTION_APP_NOTIFICATION_PROMOTION_SETTINGS)
            .putExtra(Settings.EXTRA_APP_PACKAGE, context.packageName)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    } else {
        NotificationPermission.settingsIntent(context)
    }

private fun Context.open(intent: Intent) {
    try {
        startActivity(intent)
    } catch (_: ActivityNotFoundException) {
        startActivity(NotificationPermission.settingsIntent(this))
    }
}
