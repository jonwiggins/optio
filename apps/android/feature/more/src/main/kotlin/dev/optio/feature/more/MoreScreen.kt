package dev.optio.feature.more

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.AccountCircle
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material.icons.outlined.Devices
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Settings
import androidx.compose.material.icons.outlined.SwapHoriz
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import coil3.compose.AsyncImage
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.SecretsRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.navigation.routes.SettingsRoute
import dev.optio.core.navigation.routes.WebhooksRoute
import dev.optio.core.navigation.routes.WorkspaceSettingsRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.components.ConfirmDialog
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.getWorkspace
import dev.optio.feature.more.api.listWorkspaces
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import dev.optio.feature.more.workspace.WorkspaceSwitcherSheet
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/**
 * The More hub's content (iOS `MoreHubView`): the web sidebar's Admin group (Secrets, Webhooks,
 * Workspace, Settings) and the Account section (who you are, the paired servers, the workspace
 * switcher, sign out). The hub chrome (title, server switcher) comes from `:app`; [contentPadding]
 * goes on the scrolling list.
 */
@Composable
fun MoreScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val session = LocalSessionStore.current
    val user = LocalCurrentUser.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel { MoreHubViewModel(api) }
    val active by session.activeServer.collectAsStateWithLifecycle()
    val servers by session.servers.collectAsStateWithLifecycle()
    val overrideWorkspaceId by session.workspaceId.collectAsStateWithLifecycle()
    val workspaceName by viewModel.workspaceName.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var showSwitcher by rememberSaveable { mutableStateOf(false) }

    val workspaceId = overrideWorkspaceId ?: user?.workspaceId
    val authDisabled = user?.authDisabled == true
    LaunchedEffect(viewModel, workspaceId, authDisabled) { viewModel.loadWorkspaceName(workspaceId, authDisabled) }

    MoreHubContent(
        user = user,
        active = active,
        serverCount = servers.size,
        workspaceName = workspaceName,
        contentPadding = contentPadding,
        modifier = modifier,
        onOpen = navigator::push,
        onSwitchWorkspace = { showSwitcher = true },
        onRefresh = {
            session.refreshUser()
            viewModel.loadWorkspaceName(session.workspaceId.value ?: session.user.value?.workspaceId, authDisabled)
        },
        // Runs in the session's scope: it finishes although it tears this shell down.
        onSignOut = { scope.launch { session.signOut() } },
    )

    if (showSwitcher) {
        WorkspaceSwitcherSheet(
            currentWorkspaceId = workspaceId,
            onDismiss = { showSwitcher = false },
            onSwitched = viewModel::reloadWorkspaceName,
        )
    }
}

/** The More hub, stateless: what [MoreScreen] draws (and the screenshot tests render). */
@Composable
fun MoreHubContent(
    user: CurrentUser?,
    active: ServerProfile?,
    serverCount: Int,
    workspaceName: String?,
    contentPadding: PaddingValues,
    onOpen: (androidx.navigation3.runtime.NavKey) -> Unit,
    onSwitchWorkspace: () -> Unit,
    onRefresh: suspend () -> Unit,
    onSignOut: () -> Unit,
    modifier: Modifier = Modifier,
) {
    var confirmSignOut by rememberSaveable { mutableStateOf(false) }
    val multiple = serverCount > 1
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("more-hub")) {
        LazyColumn(Modifier.fillMaxSize().readableWidth(), contentPadding = contentPadding) {
            groupedItem("admin", header = "Admin") {
                SettingsRow("Secrets", icon = Icons.Outlined.Key, onClick = { onOpen(SecretsRoute) }, modifier = Modifier.testTag("more-secrets"))
                InsetDivider(start = 56.dp)
                SettingsRow("Webhooks", icon = Icons.Outlined.Webhook, onClick = { onOpen(WebhooksRoute) }, modifier = Modifier.testTag("more-webhooks"))
                InsetDivider(start = 56.dp)
                SettingsRow("Workspace", icon = Icons.Outlined.Business, onClick = { onOpen(WorkspaceSettingsRoute) }, modifier = Modifier.testTag("more-workspace"))
                InsetDivider(start = 56.dp)
                SettingsRow("Settings", icon = Icons.Outlined.Settings, onClick = { onOpen(SettingsRoute) }, modifier = Modifier.testTag("more-settings"))
            }
            groupedItem("account", header = "Account") {
                AccountCard(user = user, host = active?.host)
                InsetDivider()
                SettingsRow(
                    "Servers",
                    icon = Icons.Outlined.Devices,
                    onClick = { onOpen(ServersRoute) },
                    modifier = Modifier.testTag("more-servers"),
                    trailingContent = if (active != null) {
                        {
                            ServerDot(Color(active.color.argb))
                            Text(
                                if (multiple) "${active.shortName} · $serverCount" else active.shortName,
                                style = OptioTheme.type.body,
                                color = OptioTheme.colors.secondaryLabel,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                                modifier = Modifier.widthIn(max = 180.dp),
                            )
                        }
                    } else {
                        null
                    },
                )
                InsetDivider(start = 56.dp)
                SettingsRow(
                    "Workspace",
                    icon = Icons.Outlined.SwapHoriz,
                    value = workspaceName ?: "Default",
                    chevron = false,
                    onClick = onSwitchWorkspace,
                    modifier = Modifier.testTag("more-switch-workspace"),
                )
                InsetDivider(start = 56.dp)
                SettingsRow(
                    "Sign out",
                    icon = Icons.AutoMirrored.Outlined.Logout,
                    tint = OptioTheme.colors.red,
                    chevron = false,
                    onClick = { confirmSignOut = true },
                    modifier = Modifier.testTag("more-sign-out"),
                )
            }
            bottomSpacer()
        }
    }
    if (confirmSignOut) {
        ConfirmDialog(
            title = if (multiple) "Sign out of ${active?.name ?: "this server"}?" else "Sign out of Optio?",
            message = if (multiple) {
                "Its access token is removed from this phone; the app switches to your next server."
            } else {
                "Your access token will be removed from this device."
            },
            confirmLabel = "Sign out",
            destructive = true,
            onConfirm = onSignOut,
            onDismiss = { confirmSignOut = false },
        )
    }
}

/** Avatar, name, email, workspace role and the server host (iOS `accountCard`). */
@Composable
internal fun AccountCard(
    user: CurrentUser?,
    host: String?,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("account-card"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Avatar(user?.avatarUrl)
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(user?.displayName?.takeIf { it.isNotBlank() } ?: "Signed in", style = OptioTheme.type.body, color = colors.label, maxLines = 1)
            user?.email?.let { Text(it, style = OptioTheme.type.footnote, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                user?.role?.let { StatusBadge(text = it, tone = Tone.WORKING) }
                host?.let {
                    Text(it, style = OptioTheme.type.caption2, color = colors.tertiaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
            }
        }
    }
}

@Composable
private fun Avatar(url: String?) {
    val size = 44.dp
    if (url.isNullOrBlank()) {
        Icon(Icons.Outlined.AccountCircle, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(size))
    } else {
        Box(Modifier.size(size).clip(CircleShape).background(OptioTheme.colors.fillTertiary)) {
            AsyncImage(model = url, contentDescription = null, contentScale = ContentScale.Crop, modifier = Modifier.fillMaxSize())
        }
    }
}

/** The hub's one piece of remote state: the current workspace's name for the switcher row. */
class MoreHubViewModel(private val api: ApiClient) : ViewModel() {
    private val _workspaceName = MutableStateFlow<String?>(null)

    /** The name to show; null → "Default" (auth-disabled servers have no workspaces). */
    val workspaceName: StateFlow<String?> = _workspaceName.asStateFlow()

    /** iOS `MoreHubView.refresh`: the override / default workspace by id, else the first listed. */
    suspend fun loadWorkspaceName(
        workspaceId: String?,
        authDisabled: Boolean,
    ) {
        if (authDisabled) {
            _workspaceName.value = null
            return
        }
        _workspaceName.value = resolveWorkspaceName(api, workspaceId) ?: _workspaceName.value
    }

    /** Fire-and-forget [loadWorkspaceName] (after a switch). */
    fun reloadWorkspaceName(workspaceId: String?) {
        viewModelScope.launch { loadWorkspaceName(workspaceId, authDisabled = false) }
    }
}

/** The name of [workspaceId], else of the first workspace the user belongs to; null when neither answers. */
internal suspend fun resolveWorkspaceName(
    api: ApiClient,
    workspaceId: String?,
): String? {
    if (workspaceId != null) {
        try {
            return api.getWorkspace(workspaceId).workspace.displayName
        } catch (e: CancellationException) {
            throw e
        } catch (_: ApiError) {
            // Fall through to the list (a stale override, or a server without workspaces).
        }
    }
    return try {
        api.listWorkspaces().firstOrNull()?.displayName
    } catch (e: CancellationException) {
        throw e
    } catch (_: ApiError) {
        null
    }
}
