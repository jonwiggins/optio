package dev.optio.feature.more.workspace

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Business
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.api.listWorkspaces
import dev.optio.feature.more.api.switchWorkspace
import dev.optio.feature.more.ui.AuthDisabledState
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.isAuthDisabledRejection
import dev.optio.feature.more.ui.moreErrorText
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

/**
 * The active-workspace picker (iOS `WorkspaceSwitcherSheet`). Like the web's switcher it does both:
 * `POST /api/workspaces/:id/switch` (the server-side default, which sockets use) and the local
 * override every request sends as `x-workspace-id` (`SessionStore.setWorkspaceId`, persisted on
 * the server profile), then re-reads the user so roles follow the new workspace.
 */
@Composable
fun WorkspaceSwitcherSheet(
    currentWorkspaceId: String?,
    onDismiss: () -> Unit,
    onSwitched: (workspaceId: String) -> Unit,
) {
    val api = LocalApiClient.current
    val session = LocalSessionStore.current
    val toaster = LocalToaster.current
    val authDisabled = LocalCurrentUser.current?.authDisabled == true
    val model = remember(api, session) { WorkspaceSwitcher(api, session) }
    val scope = rememberCoroutineScope()
    var showCreate by remember { mutableStateOf(false) }
    LaunchedEffect(model) { model.load() }

    fun switchTo(workspace: WorkspaceRow) {
        scope.launch {
            val error = model.switchTo(workspace)
            if (error == null) {
                onSwitched(workspace.id)
                onDismiss()
            } else {
                toaster.error(moreErrorText(error))
            }
        }
    }

    MoreSheet(title = "Switch Workspace", onDismiss = onDismiss, dismissLabel = null, confirmLabel = "Done", onConfirm = onDismiss) {
        WorkspaceSwitcherContent(
            workspaces = model.workspaces,
            loading = model.loading,
            loadError = model.loadError,
            authDisabled = authDisabled,
            currentId = currentWorkspaceId,
            switchingId = model.switching,
            onSelect = ::switchTo,
            onCreate = { showCreate = true },
        )
    }

    if (showCreate) {
        CreateWorkspaceSheet(
            onDismiss = { showCreate = false },
            onCreated = { workspace ->
                showCreate = false
                scope.launch {
                    model.load()
                    switchTo(workspace)
                }
            },
        )
    }
}

/** The switcher's list, stateless. */
@Composable
fun WorkspaceSwitcherContent(
    workspaces: List<WorkspaceRow>,
    loading: Boolean,
    loadError: Throwable?,
    authDisabled: Boolean,
    currentId: String?,
    switchingId: String?,
    onSelect: (WorkspaceRow) -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth()) {
        when {
            loading -> SkeletonRows(count = 2)
            isAuthDisabledRejection(loadError, authDisabled) || (authDisabled && workspaces.isEmpty()) -> AuthDisabledState("workspaces")
            workspaces.isEmpty() -> EmptyState(title = "No workspaces", icon = Icons.Outlined.Business, message = loadError?.let(::moreErrorText))
            else -> GroupedSection {
                workspaces.forEachIndexed { index, workspace ->
                    if (index > 0) InsetDivider()
                    val selected = workspace.id == currentId
                    OptioRow(
                        title = workspace.displayName,
                        meta = metaText(workspace.slug?.let(::mono), workspace.role),
                        onClick = if (switchingId == null && !selected) {
                            { onSelect(workspace) }
                        } else {
                            null
                        },
                        modifier = Modifier.testTag("workspace-${workspace.slug ?: workspace.id}"),
                        trailingContent = {
                            when {
                                switchingId == workspace.id -> CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                                selected -> Icon(Icons.Filled.Check, contentDescription = "Current", tint = OptioTheme.colors.accent)
                            }
                        },
                    )
                }
            }
        }
        if (!authDisabled) {
            GroupedSection(modifier = Modifier.padding(top = Spacing.m)) {
                SettingsRow("New workspace", icon = Icons.Outlined.Add, tint = OptioTheme.colors.accent, chevron = false, onClick = onCreate)
            }
        }
    }
}

/** State and actions of the switcher (a plain holder: the sheet is short-lived, like iOS `@State`). */
@Stable
class WorkspaceSwitcher(
    private val api: ApiClient,
    private val session: SessionStore,
) {
    var workspaces by mutableStateOf<List<WorkspaceRow>>(emptyList())
        private set
    var loading by mutableStateOf(true)
        private set
    var loadError by mutableStateOf<Throwable?>(null)
        private set

    /** The workspace being switched to; every row is disabled meanwhile. */
    var switching by mutableStateOf<String?>(null)
        private set

    suspend fun load() {
        try {
            workspaces = api.listWorkspaces()
            loadError = null
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            loadError = e
        } finally {
            loading = false
        }
    }

    /** Switches server-side, then locally; returns the failure, or null on success. */
    suspend fun switchTo(workspace: WorkspaceRow): Throwable? {
        switching = workspace.id
        return try {
            api.switchWorkspace(workspace.id)
            session.setWorkspaceId(workspace.id)
            session.refreshUser()
            null
        } catch (e: CancellationException) {
            throw e
        } catch (e: ApiError) {
            e
        } finally {
            switching = null
        }
    }
}
