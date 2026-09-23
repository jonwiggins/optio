package dev.optio.feature.more.settings

import android.content.ActivityNotFoundException
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.automirrored.outlined.List
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.filled.Notifications
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.outlined.Android
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.HourglassTop
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.NotificationsNone
import androidx.compose.material.icons.outlined.NotificationsOff
import androidx.compose.material.icons.outlined.PhoneIphone
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushState
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.ServerPushState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.NotificationPrefsRoute
import dev.optio.core.navigation.routes.WatchSettingsRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.api.PushDeviceRow
import dev.optio.feature.more.api.PushDevices
import dev.optio.feature.more.api.deletePushDevice
import dev.optio.feature.more.api.listPushDevices
import dev.optio.feature.more.api.sendTestPush
import dev.optio.feature.more.ui.CardNote
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.NoticeViewModel
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import dev.optio.feature.more.ui.moreErrorText
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The user's registered devices on the active server (`/api/notifications/devices`, iOS and
 * Android rows), removal by row id (the list masks tokens), and the server's test push.
 */
class NotificationDevicesViewModel(private val api: ApiClient) : NoticeViewModel() {
    private val _state = MutableStateFlow<LoadState<PushDevices>>(LoadState.Idle)
    val state: StateFlow<LoadState<PushDevices>> = _state.asStateFlow()

    private val _sending = MutableStateFlow(false)
    val sending: StateFlow<Boolean> = _sending.asStateFlow()

    private var loadJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { load() }
    }

    suspend fun load() {
        _state.load { api.listPushDevices() }
    }

    fun remove(device: PushDeviceRow) {
        val ref = device.deleteRef ?: return
        viewModelScope.launch {
            try {
                api.deletePushDevice(ref)
                val current = _state.value.value
                if (current != null) _state.value = LoadState.Loaded(current.copy(devices = current.devices.filter { it.listKey != device.listKey }))
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                fail(e)
            }
        }
    }

    /** `POST /api/notifications/devices/test`: one alert to every device, through APNs and FCM. */
    fun sendTest() {
        if (_sending.value) return
        _sending.value = true
        viewModelScope.launch {
            try {
                val sent = api.sendTestPush()
                notify(if (sent == 1) "Sent a test to 1 device." else "Sent a test to $sent devices.")
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                // 503 = neither APNs nor FCM configured: the server's sentence says exactly that.
                if (e.status == 503) fail(e.message) else fail(e)
            } catch (e: Exception) {
                fail(e)
            } finally {
                _sending.value = false
            }
        }
    }
}

/** True when [device] is this phone (A9's `PushState.isThisDevice`, over the tolerant row). */
internal fun PushState.isThisPhone(device: PushDeviceRow): Boolean {
    if (!device.isAndroid) return false
    val registered = servers.values.mapNotNull { it.deviceId }
    val masked = maskedToken
    return (device.id != null && device.id in registered) || (masked != null && device.maskedToken == masked)
}

/** `NotificationDevicesRoute` (iOS `NotificationsDevicesView`, "This iPhone" → "This phone"). */
@Composable
fun NotificationDevicesScreen() {
    val api = LocalApiClient.current
    val context = LocalContext.current
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val authDisabled = LocalCurrentUser.current?.authDisabled == true
    val push = remember(context) { PushStatus.get(context) }
    val pushState by push.state.collectAsStateWithLifecycle()
    val servers by session.servers.collectAsStateWithLifecycle()
    val active by session.activeServer.collectAsStateWithLifecycle()
    val viewModel = viewModel { NotificationDevicesViewModel(api) }
    val devices by viewModel.state.collectAsStateWithLifecycle()
    val sending by viewModel.sending.collectAsStateWithLifecycle()
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel, authDisabled) { if (!authDisabled) viewModel.load() }
    // Coming back from system settings after flipping the switch.
    LifecycleResumeEffect(push) {
        push.refreshPermission(context)
        onPauseOrDispose { }
    }
    val requestPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) {
        push.markPrompted(context)
    }
    val scope = rememberCoroutineScope()

    MoreScaffold("This phone") { padding ->
        NotificationDevicesContent(
            push = pushState,
            devices = devices,
            servers = servers,
            activeServerId = active?.id,
            authDisabled = authDisabled,
            canMutate = Roles.canMutate,
            sending = sending,
            contentPadding = padding,
            onRefresh = {
                push.refreshPermission(context)
                push.syncNow()
                if (!authDisabled) viewModel.load()
            },
            onRequestPermission = {
                if (NotificationPermission.isRuntime) {
                    requestPermission.launch(NotificationPermission.PERMISSION)
                } else {
                    openNotificationSettings(context)
                }
            },
            onOpenSettings = { openNotificationSettings(context) },
            onRetryRegistration = { scope.launch { push.syncNow() } },
            onRetryDevices = viewModel::refresh,
            onRemove = viewModel::remove,
            onSendTest = viewModel::sendTest,
            onOpen = navigator::push,
        )
    }
}

private fun openNotificationSettings(context: android.content.Context) {
    try {
        context.startActivity(NotificationPermission.settingsIntent(context))
    } catch (_: ActivityNotFoundException) {
        // No settings screen (some test devices): nothing to open.
    }
}

/** The screen body, stateless. */
@Composable
fun NotificationDevicesContent(
    push: PushState,
    devices: LoadState<PushDevices>,
    servers: List<ServerProfile>,
    activeServerId: String?,
    authDisabled: Boolean,
    canMutate: Boolean,
    sending: Boolean,
    contentPadding: PaddingValues,
    onRefresh: suspend () -> Unit,
    onRequestPermission: () -> Unit,
    onOpenSettings: () -> Unit,
    onRetryRegistration: () -> Unit,
    onRetryDevices: () -> Unit,
    onRemove: (PushDeviceRow) -> Unit,
    onSendTest: () -> Unit,
    onOpen: (NavKey) -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val confirm = rememberConfirmState()
    val now = rememberNow()
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("notification-devices"), contentPadding = contentPadding) {
            groupedItem(
                "alerts",
                header = "Alerts",
                footer = "Optio only alerts when something needs you: a terminal waiting on a reply, a task that stalled, an agent that answered. Working and idle are silent.",
            ) {
                val (icon, tint) = permissionIcon(push.permission)
                SettingsRow(push.permission.label, icon = icon, iconTint = tint, chevron = false, modifier = Modifier.testTag("permission-state"))
                when (push.permission) {
                    NotificationPermissionState.NOT_DETERMINED -> {
                        InsetDivider()
                        SettingsRow(
                            "Enable notifications",
                            icon = Icons.Outlined.NotificationsActive,
                            tint = colors.accent,
                            chevron = false,
                            onClick = onRequestPermission,
                            modifier = Modifier.testTag("request-permission"),
                        )
                    }
                    NotificationPermissionState.DENIED -> {
                        InsetDivider()
                        SettingsRow(
                            "Open system settings",
                            icon = Icons.Outlined.Settings,
                            tint = colors.accent,
                            chevron = false,
                            onClick = onOpenSettings,
                            modifier = Modifier.testTag("open-notification-settings"),
                        )
                    }
                    NotificationPermissionState.GRANTED -> Unit
                }
            }
            groupedItem(
                "push",
                header = "Push delivery",
                footer = if (push.fcm == FcmAvailability.NotConfigured) {
                    "Banners from the server need a build with Firebase. Everything else — the Watch notification, widgets and the background check — works without it."
                } else {
                    null
                },
            ) {
                PushDeliveryRows(push, servers, activeServerId, onRetryRegistration)
            }
            groupedItem("devices", header = "Your devices") {
                DevicesRows(
                    push = push,
                    devices = devices,
                    authDisabled = authDisabled,
                    canMutate = canMutate,
                    nowText = { it.relativeDescription(now) },
                    onRetry = onRetryDevices,
                    onRemove = { device ->
                        confirm.ask(
                            title = "Remove ${device.deviceName ?: "this device"}?",
                            message = "It stops getting push from this server until the app registers it again.",
                            confirmLabel = "Remove",
                            destructive = true,
                        ) { onRemove(device) }
                    },
                )
                if (canMutate && !authDisabled) {
                    InsetDivider()
                    SettingsRow(
                        "Send test notification",
                        icon = Icons.AutoMirrored.Outlined.Send,
                        tint = colors.accent,
                        chevron = false,
                        busy = sending,
                        onClick = onSendTest,
                        modifier = Modifier.testTag("send-test-push"),
                    )
                }
            }
            groupedItem("links", footer = "Per-event toggles are shared with your browser subscriptions.") {
                SettingsRow("What to notify me about", icon = Icons.AutoMirrored.Outlined.List, onClick = { onOpen(NotificationPrefsRoute) }, modifier = Modifier.testTag("open-prefs"))
                InsetDivider(start = 56.dp)
                SettingsRow("Watch and background checks", icon = Icons.Outlined.Visibility, onClick = { onOpen(WatchSettingsRoute) }, modifier = Modifier.testTag("open-watch-settings"))
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun permissionIcon(permission: NotificationPermissionState): Pair<ImageVector, Color> = when (permission) {
    NotificationPermissionState.GRANTED -> Icons.Filled.Notifications to OptioTheme.colors.accent
    NotificationPermissionState.DENIED -> Icons.Outlined.NotificationsOff to OptioTheme.colors.red
    NotificationPermissionState.NOT_DETERMINED -> Icons.Outlined.NotificationsNone to OptioTheme.colors.secondaryLabel
}

/** Firebase in this build, this device's token, and its registration with each paired server. */
@Composable
private fun PushDeliveryRows(
    push: PushState,
    servers: List<ServerProfile>,
    activeServerId: String?,
    onRetryRegistration: () -> Unit,
) {
    val colors = OptioTheme.colors
    val active = push.server(activeServerId)
    val registration = active?.registration ?: PushRegistration.IDLE
    val (icon, tint) = when (registration) {
        PushRegistration.REGISTERED -> Icons.Filled.Verified to colors.green
        PushRegistration.REGISTERING -> Icons.Outlined.HourglassTop to colors.secondaryLabel
        PushRegistration.FAILED, PushRegistration.UNSUPPORTED -> Icons.Outlined.ErrorOutline to colors.secondaryLabel
        PushRegistration.IDLE -> Icons.Outlined.RadioButtonUnchecked to colors.secondaryLabel
    }
    val server = active ?: ServerPushState(serverId = activeServerId ?: "")
    SettingsRow(
        server.label(push),
        subtitle = server.detail(push),
        icon = icon,
        iconTint = tint,
        chevron = false,
        modifier = Modifier.testTag("registration-state"),
    )
    InsetDivider()
    KeyValueRow("Firebase", fcmLabel(push.fcm))
    push.maskedToken?.let {
        InsetDivider()
        KeyValueRow("Token", it, mono = true)
    }
    if (servers.size > 1) {
        servers.forEach { profile ->
            InsetDivider()
            val state = push.server(profile.id)
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("push-server-${profile.id}"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                ServerDot(Color(profile.color.argb))
                Text(profile.name, style = OptioTheme.type.body, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                Text(registrationShort(state?.registration, state?.serverCanPush), style = OptioTheme.type.footnote, color = colors.secondaryLabel)
            }
        }
    }
    if (registration == PushRegistration.FAILED || registration == PushRegistration.UNSUPPORTED) {
        InsetDivider()
        SettingsRow(
            "Retry registration",
            icon = Icons.Outlined.Refresh,
            tint = colors.accent,
            chevron = false,
            onClick = onRetryRegistration,
            modifier = Modifier.testTag("retry-registration"),
        )
    }
}

internal fun fcmLabel(fcm: FcmAvailability): String = when (fcm) {
    FcmAvailability.Available -> "Available"
    FcmAvailability.NotConfigured -> "Not in this build"
    FcmAvailability.Unknown -> "Checking…"
    is FcmAvailability.Unavailable -> "Unavailable: ${fcm.reason}"
}

internal fun registrationShort(
    registration: PushRegistration?,
    serverCanPush: Boolean?,
): String = when (registration ?: PushRegistration.IDLE) {
    PushRegistration.REGISTERED -> if (serverCanPush == false) "Registered · no FCM" else "Registered"
    PushRegistration.REGISTERING -> "Registering…"
    PushRegistration.FAILED -> "Failed"
    PushRegistration.UNSUPPORTED -> "Not supported"
    PushRegistration.IDLE -> "Not registered"
}

/** The server's device list (iOS `devicesSection`). */
@Composable
private fun DevicesRows(
    push: PushState,
    devices: LoadState<PushDevices>,
    authDisabled: Boolean,
    canMutate: Boolean,
    nowText: (String) -> String,
    onRetry: () -> Unit,
    onRemove: (PushDeviceRow) -> Unit,
) {
    val colors = OptioTheme.colors
    if (authDisabled) {
        CardNote("This server runs with authentication disabled, so devices can't register with it.")
        return
    }
    val value = devices.value
    val error = devices.errorOrNull
    when {
        value == null && error is ApiError && error.status == ApiError.NOT_FOUND -> CardNote("This server doesn't register devices yet.")
        value == null && error != null -> SettingsRow(moreErrorText(error), icon = Icons.Outlined.ErrorOutline, iconTint = colors.red, chevron = false, onClick = onRetry)
        value == null -> SkeletonRows(count = 2)
        else -> {
            value.push?.let {
                KeyValueRow("Server push", serverPushLabel(it.apns, it.fcm))
                InsetDivider()
            }
            if (value.devices.isEmpty()) {
                CardNote("No devices registered.")
            } else {
                value.devices.forEachIndexed { index, device ->
                    if (index > 0) InsetDivider(start = 56.dp)
                    DeviceRow(device, isThisPhone = push.isThisPhone(device), canRemove = canMutate && device.deleteRef != null, nowText = nowText, onRemove = { onRemove(device) })
                }
            }
        }
    }
}

internal fun serverPushLabel(
    apns: Boolean,
    fcm: Boolean,
): String = when {
    apns && fcm -> "Android and iPhone"
    fcm -> "Android (FCM)"
    apns -> "iPhone only (APNs)"
    else -> "Not configured"
}

@Composable
private fun DeviceRow(
    device: PushDeviceRow,
    isThisPhone: Boolean,
    canRemove: Boolean,
    nowText: (String) -> String,
    onRemove: () -> Unit,
) {
    val colors = OptioTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = if (canRemove) Spacing.xs else Spacing.l, top = Spacing.m, bottom = Spacing.m).testTag("device-${device.listKey}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.l),
    ) {
        Icon(
            if (device.isAndroid) Icons.Outlined.Android else Icons.Outlined.PhoneIphone,
            contentDescription = if (device.isAndroid) "Android" else "iPhone",
            tint = colors.secondaryLabel,
            modifier = Modifier.size(22.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(device.deviceName ?: "Unnamed device", style = OptioTheme.type.body, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f, fill = false))
                if (isThisPhone) {
                    Text(
                        "this phone",
                        style = OptioTheme.type.caption2,
                        color = colors.accent,
                        modifier = Modifier.background(colors.accent.copy(alpha = 0.15f), Radius.capsuleShape).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            Text(
                listOfNotNull(device.maskedToken.takeIf { it.isNotEmpty() }, device.environment ?: device.bundleEnv, device.appVersion).joinToString(" · "),
                style = OptioTheme.type.monoCaption,
                color = colors.secondaryLabel,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            device.lastSeenAt?.let { Text("Last seen ${nowText(it)}", style = OptioTheme.type.caption2, color = colors.tertiaryLabel) }
        }
        if (canRemove) {
            IconButton(onClick = onRemove, modifier = Modifier.testTag("remove-device-${device.listKey}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Remove", tint = colors.secondaryLabel)
            }
        }
    }
}
