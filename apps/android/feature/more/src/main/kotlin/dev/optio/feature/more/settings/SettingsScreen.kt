package dev.optio.feature.more.settings

import android.content.Context
import android.content.pm.PackageManager
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
import androidx.compose.material.icons.automirrored.outlined.HelpOutline
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.Cancel
import androidx.compose.material.icons.filled.CheckCircle
import androidx.compose.material.icons.filled.Verified
import androidx.compose.material.icons.outlined.Apps
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Circle
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Notifications
import androidx.compose.material.icons.outlined.PhonelinkRing
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.RemoveModerator
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ApiKeysRoute
import dev.optio.core.navigation.routes.AppIconRoute
import dev.optio.core.navigation.routes.NotificationDevicesRoute
import dev.optio.core.navigation.routes.NotificationPrefsRoute
import dev.optio.core.navigation.routes.OptioAgentSettingsRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmDialog
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.api.AuthProviders
import dev.optio.feature.more.api.ClaudeAuthStatus
import dev.optio.feature.more.ui.CardNote
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import kotlinx.coroutines.launch

/** The sign-in providers iOS lists, in order, with their labels. */
internal val SIGN_IN_PROVIDERS = listOf(
    "github" to "GitHub",
    "google" to "Google",
    "gitlab" to "GitLab",
    "oidc" to "OpenID Connect",
)

/** `SettingsRoute` (iOS `SettingsView`). */
@Composable
fun SettingsScreen() {
    val api = LocalApiClient.current
    val session = LocalSessionStore.current
    val user = LocalCurrentUser.current
    val navigator = LocalNavigator.current
    val context = LocalContext.current
    val viewModel = viewModel { SettingsViewModel(api) }
    val claude by viewModel.claude.collectAsStateWithLifecycle()
    val providers by viewModel.providers.collectAsStateWithLifecycle()
    val refreshing by viewModel.refreshing.collectAsStateWithLifecycle()
    val active by session.activeServer.collectAsStateWithLifecycle()
    val overrideId by session.workspaceId.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val version = remember(context) { appVersion(context) }
    val icon = remember(context) { AppIcons.current(context) }
    CollectNotices(viewModel.notices)

    MoreScaffold("Settings") { padding ->
        SettingsContent(
            claude = claude,
            providers = providers,
            isAdmin = Roles.isAdmin,
            refreshing = refreshing,
            server = active,
            version = version,
            workspaceId = overrideId ?: user?.workspaceId,
            appIcon = icon,
            contentPadding = padding,
            onOpen = navigator::push,
            onRefresh = viewModel::load,
            onRefreshClaude = viewModel::refreshClaude,
            onSignOut = { scope.launch { session.signOut() } },
            appearance = { AppearancePicker() },
        )
    }
}

/** The settings list, stateless. [appearance] is the appearance row (a store-backed picker in the app). */
@Composable
fun SettingsContent(
    claude: LoadState<ClaudeAuthStatus.Subscription>,
    providers: AuthProviders?,
    isAdmin: Boolean,
    refreshing: Boolean,
    server: ServerProfile?,
    version: String,
    workspaceId: String?,
    appIcon: AppIconOption,
    contentPadding: PaddingValues,
    onOpen: (NavKey) -> Unit,
    onRefresh: suspend () -> Unit,
    onRefreshClaude: () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
    appearance: @Composable () -> Unit = { AppearancePicker() },
) {
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    val colors = OptioTheme.colors
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("settings"), contentPadding = contentPadding) {
            groupedItem("optio", header = "Optio") {
                SettingsRow("Optio agent settings", icon = Icons.Outlined.AutoAwesome, onClick = { onOpen(OptioAgentSettingsRoute) })
                InsetDivider(start = 56.dp)
                SettingsRow("Personal access tokens", icon = Icons.Outlined.VpnKey, onClick = { onOpen(ApiKeysRoute) }, modifier = Modifier.testTag("settings-tokens"))
                InsetDivider(start = 56.dp)
                SettingsRow("Notifications", icon = Icons.Outlined.Notifications, onClick = { onOpen(NotificationPrefsRoute) }, modifier = Modifier.testTag("settings-notifications"))
                InsetDivider(start = 56.dp)
                SettingsRow(
                    "Notifications on this phone",
                    icon = Icons.Outlined.PhonelinkRing,
                    onClick = { onOpen(NotificationDevicesRoute) },
                    modifier = Modifier.testTag("settings-devices"),
                )
            }
            groupedItem(
                "claude",
                header = "Claude authentication",
                footer = "Agents authenticate with CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY from Secrets. Paste a new value there when the token expires.",
            ) {
                ClaudeStatus(claude)
                if (isAdmin) {
                    InsetDivider()
                    SettingsRow(
                        "Refresh credential cache",
                        icon = Icons.Outlined.Refresh,
                        tint = colors.accent,
                        chevron = false,
                        busy = refreshing,
                        onClick = onRefreshClaude,
                        modifier = Modifier.testTag("refresh-claude"),
                    )
                }
            }
            groupedItem(
                "providers",
                header = "Sign-in providers",
                footer = "OAuth providers are detected from <PROVIDER>_OAUTH_CLIENT_ID / _SECRET on the server.",
            ) {
                if (providers?.authDisabled == true) {
                    CardNote("Authentication is disabled on this server (OPTIO_AUTH_DISABLED).", icon = Icons.Outlined.RemoveModerator)
                    InsetDivider()
                }
                SIGN_IN_PROVIDERS.forEachIndexed { index, (name, label) ->
                    if (index > 0) InsetDivider(start = 56.dp)
                    val enabled = providers?.providers.orEmpty().any { it.name == name }
                    SettingsRow(
                        label,
                        icon = if (enabled) Icons.Filled.CheckCircle else Icons.Outlined.Circle,
                        tint = if (enabled) null else colors.tertiaryLabel,
                        chevron = false,
                        trailingContent = {
                            Text(if (enabled) "Configured" else "Not configured", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                        },
                    )
                }
            }
            groupedItem("app", header = "App") {
                appearance()
                InsetDivider()
                SettingsRow(
                    "App icon",
                    icon = Icons.Outlined.Apps,
                    onClick = { onOpen(AppIconRoute) },
                    modifier = Modifier.testTag("settings-app-icon"),
                    trailingContent = { AppIconThumbnail(appIcon, size = 28.dp) },
                )
                if (server != null) {
                    InsetDivider()
                    ServerInfoRow(server)
                }
                InsetDivider()
                KeyValueRow("Version", version)
                if (workspaceId != null) {
                    InsetDivider()
                    KeyValueRow("Workspace", workspaceId, mono = true)
                }
                InsetDivider()
                SettingsRow(
                    "Sign out",
                    icon = Icons.AutoMirrored.Outlined.Logout,
                    tint = colors.red,
                    chevron = false,
                    onClick = { confirmSignOut = true },
                    modifier = Modifier.testTag("settings-sign-out"),
                )
            }
            bottomSpacer()
        }
    }
    if (confirmSignOut) {
        ConfirmDialog(
            title = "Sign out of Optio?",
            confirmLabel = "Sign out",
            destructive = true,
            onConfirm = onSignOut,
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** The Claude token status row(s) (iOS: expired / available / none, plus expiry and last check). */
@Composable
private fun ClaudeStatus(state: LoadState<ClaudeAuthStatus.Subscription>) {
    val colors = OptioTheme.colors
    val now = rememberNow()
    val claude = state.value
    when {
        claude != null -> {
            val expired = claude.expired == true
            val available = claude.available == true
            val (icon, tint, label) = when {
                expired -> Triple(Icons.Filled.Cancel, colors.red, "Token expired")
                available -> Triple(Icons.Filled.Verified, colors.green, "Token available")
                else -> Triple(Icons.AutoMirrored.Outlined.HelpOutline, colors.secondaryLabel, "No token configured")
            }
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("claude-status"),
                horizontalArrangement = Arrangement.spacedBy(Spacing.l),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(icon, contentDescription = null, tint = tint, modifier = Modifier.size(22.dp))
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    Text(label, style = OptioTheme.type.body, color = colors.label)
                    claude.error?.takeIf { it.isNotEmpty() }?.let { Text(it, style = OptioTheme.type.caption, color = colors.secondaryLabel) }
                }
            }
            claude.expiresAt?.let {
                InsetDivider()
                KeyValueRow("Expires", it.relativeDescription(now))
            }
            claude.lastValidated?.let {
                InsetDivider()
                KeyValueRow("Last validated", it.relativeDescription(now))
            }
        }
        state is LoadState.Failed -> Row(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = colors.red, modifier = Modifier.size(18.dp))
            Text(ErrorText.humanize(state.error, "the token status"), style = OptioTheme.type.footnote, color = colors.red)
        }
        else -> Row(Modifier.fillMaxWidth().padding(Spacing.l), horizontalArrangement = Arrangement.Center) {
            CircularProgressIndicator(Modifier.size(22.dp), strokeWidth = 2.dp)
        }
    }
}

/** Server: dot and name, the address in mono under it (iOS Settings › App › Server). */
@Composable
private fun ServerInfoRow(server: ServerProfile) {
    val colors = OptioTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
        verticalAlignment = Alignment.Top,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Text("Server", style = OptioTheme.type.body, color = colors.label)
        Column(Modifier.weight(1f), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                ServerDot(Color(server.color.argb))
                Text(server.name, style = OptioTheme.type.body, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            Text(server.url, style = OptioTheme.type.monoFootnote, color = colors.secondaryLabel, textAlign = TextAlign.End)
        }
    }
}

/** "0.1.0 (1)" from the package (iOS `CFBundleShortVersionString (CFBundleVersion)`). */
internal fun appVersion(context: Context): String = try {
    val info = context.packageManager.getPackageInfo(context.packageName, 0)
    "${info.versionName ?: "—"} (${info.longVersionCode})"
} catch (_: PackageManager.NameNotFoundException) {
    "—"
}
