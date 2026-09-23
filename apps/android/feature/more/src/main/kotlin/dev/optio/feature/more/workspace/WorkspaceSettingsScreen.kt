package dev.optio.feature.more.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.AddBox
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.PersonAdd
import androidx.compose.material.icons.outlined.PersonRemove
import androidx.compose.material.icons.outlined.Shield
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.capitalizedFirst
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.api.WorkspaceMemberRow
import dev.optio.feature.more.ui.AuthDisabledState
import dev.optio.feature.more.ui.CardNote
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import dev.optio.feature.more.ui.isAuthDisabledRejection

/** Roles in the order the pickers list them (iOS). */
internal val WORKSPACE_ROLES = listOf("admin" to "Admin", "member" to "Member", "viewer" to "Viewer")

/** `WorkspaceSettingsRoute` (iOS `WorkspaceSettingsView`, the web's /workspace-settings). */
@Composable
fun WorkspaceSettingsScreen() {
    val api = LocalApiClient.current
    val session = LocalSessionStore.current
    val user = LocalCurrentUser.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel { WorkspaceSettingsViewModel(api, session) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val form by viewModel.form.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    val overrideId by session.workspaceId.collectAsStateWithLifecycle()
    val workspaceId = overrideId ?: user?.workspaceId
    var showCreate by rememberSaveable { mutableStateOf(false) }
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel, workspaceId) { viewModel.refresh(workspaceId) }

    MoreScaffold("Workspace") { padding ->
        WorkspaceSettingsContent(
            state = state,
            form = form,
            busy = busy,
            authDisabled = user?.authDisabled == true,
            contentPadding = padding,
            onRetry = { viewModel.refresh(workspaceId) },
            onForm = viewModel::editForm,
            onSave = viewModel::save,
            onInvite = viewModel::invite,
            onChangeRole = viewModel::changeRole,
            onRemove = viewModel::remove,
            onCreate = { showCreate = true },
            onDelete = { viewModel.delete(onDeleted = navigator::pop) },
        )
    }
    if (showCreate) {
        CreateWorkspaceSheet(
            onDismiss = { showCreate = false },
            onCreated = {
                showCreate = false
                viewModel.refresh(workspaceId)
            },
        )
    }
}

/** The workspace screen body, stateless. */
@Composable
fun WorkspaceSettingsContent(
    state: LoadState<WorkspaceData>,
    form: WorkspaceForm,
    busy: WorkspaceSettingsViewModel.Busy?,
    authDisabled: Boolean,
    contentPadding: androidx.compose.foundation.layout.PaddingValues,
    onRetry: () -> Unit,
    onForm: ((WorkspaceForm) -> WorkspaceForm) -> Unit,
    onSave: () -> Unit,
    onInvite: (email: String, role: String, onDone: () -> Unit) -> Unit,
    onChangeRole: (WorkspaceMemberRow, String) -> Unit,
    onRemove: (WorkspaceMemberRow) -> Unit,
    onCreate: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val confirm = rememberConfirmState()
    if (state is LoadState.Failed && state.value == null && isAuthDisabledRejection(state.error, authDisabled)) {
        Box(modifier.fillMaxSize().padding(contentPadding)) { AuthDisabledState("workspaces") }
        return
    }
    Loadable(state = state, onRetry = onRetry, what = "the workspace", contentPadding = contentPadding, modifier = modifier) { data ->
        val admin = data.isAdmin
        var inviteEmail by rememberSaveable { mutableStateOf("") }
        var inviteRole by rememberSaveable { mutableStateOf("member") }
        LazyColumn(Modifier.fillMaxSize().testTag("workspace-settings"), contentPadding = contentPadding) {
            groupedItem(
                "general",
                header = "General",
                footer = if (admin) "Slug: lowercase letters, numbers and hyphens." else "Only workspace admins can edit workspace settings.",
            ) {
                if (admin) {
                    Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        OutlinedTextField(
                            value = form.name,
                            onValueChange = { v -> onForm { it.copy(name = v) } },
                            label = { Text("Name") },
                            singleLine = true,
                            modifier = Modifier.fillMaxWidth().testTag("ws-name"),
                        )
                        OutlinedTextField(
                            value = form.slug,
                            onValueChange = { v -> onForm { it.copy(slug = v) } },
                            label = { Text("Slug") },
                            singleLine = true,
                            textStyle = OptioTheme.type.monoBody,
                            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, capitalization = KeyboardCapitalization.None),
                            modifier = Modifier.fillMaxWidth().testTag("ws-slug"),
                        )
                        OutlinedTextField(
                            value = form.description,
                            onValueChange = { v -> onForm { it.copy(description = v) } },
                            label = { Text("Description") },
                            minLines = 2,
                            modifier = Modifier.fillMaxWidth().testTag("ws-description"),
                        )
                        val canSave = form.isDirty(data.workspace) && form.name.isNotBlank() && form.slug.isNotBlank()
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                            if (busy == WorkspaceSettingsViewModel.Busy.SAVING) {
                                CircularProgressIndicator(Modifier.padding(end = Spacing.m).size(20.dp), strokeWidth = 2.dp)
                            }
                            FilledTonalButton(onClick = onSave, enabled = canSave && busy == null, modifier = Modifier.testTag("ws-save")) {
                                Text("Save changes")
                            }
                        }
                    }
                } else {
                    KeyValueRow("Name", data.workspace.name ?: "")
                    InsetDivider()
                    KeyValueRow("Slug", data.workspace.slug ?: "", mono = true)
                    data.workspace.description?.takeIf { it.isNotBlank() }?.let {
                        InsetDivider()
                        CardNote(it)
                    }
                }
                InsetDivider()
                KeyValueRow("Your role", (data.role ?: "member").capitalizedFirst())
            }
            groupedItem(
                "members",
                header = "Members (${data.members.size})",
                footer = if (admin) "The user must have signed in to Optio at least once to be found." else null,
            ) {
                data.members.forEachIndexed { index, member ->
                    if (index > 0) InsetDivider(start = 52.dp)
                    MemberRow(
                        member = member,
                        admin = admin,
                        canRemove = admin && data.members.size > 1,
                        onChangeRole = { role -> onChangeRole(member, role) },
                        onRemove = {
                            confirm.ask(
                                title = "Remove ${member.displayName ?: "member"} from this workspace?",
                                confirmLabel = "Remove",
                                destructive = true,
                            ) { onRemove(member) }
                        },
                    )
                }
                if (admin) {
                    if (data.members.isNotEmpty()) InsetDivider()
                    Column(Modifier.padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                            OutlinedTextField(
                                value = inviteEmail,
                                onValueChange = { inviteEmail = it },
                                label = { Text("Email") },
                                placeholder = { Text("user@example.com") },
                                singleLine = true,
                                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Email),
                                modifier = Modifier.weight(1f).testTag("invite-email"),
                            )
                            RoleMenu(role = inviteRole, onSelect = { inviteRole = it }, modifier = Modifier.testTag("invite-role"))
                        }
                        Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.End, verticalAlignment = Alignment.CenterVertically) {
                            if (busy == WorkspaceSettingsViewModel.Busy.INVITING) {
                                CircularProgressIndicator(Modifier.padding(end = Spacing.m).size(20.dp), strokeWidth = 2.dp)
                            }
                            FilledTonalButton(
                                onClick = { onInvite(inviteEmail, inviteRole) { inviteEmail = "" } },
                                enabled = inviteEmail.isNotBlank() && busy == null,
                                modifier = Modifier.testTag("invite-add"),
                            ) {
                                Icon(Icons.Outlined.PersonAdd, contentDescription = null, modifier = Modifier.size(18.dp))
                                Text("Add member", modifier = Modifier.padding(start = Spacing.s))
                            }
                        }
                    }
                }
            }
            groupedItem("create") {
                SettingsRow(
                    "Create a new workspace",
                    icon = Icons.Outlined.AddBox,
                    tint = OptioTheme.colors.accent,
                    chevron = false,
                    onClick = onCreate,
                    modifier = Modifier.testTag("ws-create"),
                )
            }
            if (admin) {
                groupedItem("danger", footer = "Permanently deletes this workspace and all its data. This cannot be undone.") {
                    SettingsRow(
                        "Delete workspace",
                        icon = Icons.Outlined.Delete,
                        tint = OptioTheme.colors.red,
                        chevron = false,
                        busy = busy == WorkspaceSettingsViewModel.Busy.DELETING,
                        onClick = {
                            confirm.ask(
                                title = "Delete this workspace?",
                                message = "All repos, tasks, secrets and settings in it will be deleted.",
                                confirmLabel = "Delete workspace",
                                destructive = true,
                                onConfirm = onDelete,
                            )
                        },
                        modifier = Modifier.testTag("ws-delete"),
                    )
                }
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** One member: role icon, name and email, and (for admins) the role menu with Remove. */
@Composable
private fun MemberRow(
    member: WorkspaceMemberRow,
    admin: Boolean,
    canRemove: Boolean,
    onChangeRole: (String) -> Unit,
    onRemove: () -> Unit,
) {
    val colors = OptioTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s).testTag("member-${member.userId}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(
            imageVector = roleIcon(member.role),
            contentDescription = null,
            tint = if (member.role == "admin") colors.accent else colors.secondaryLabel,
            modifier = Modifier.size(20.dp),
        )
        Column(Modifier.weight(1f)) {
            Text(member.label, style = OptioTheme.type.subheadline, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            member.email?.let { Text(it, style = OptioTheme.type.caption, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) }
        }
        if (admin) {
            RoleMenu(role = member.role ?: "member", onSelect = onChangeRole, onRemove = if (canRemove) onRemove else null)
        } else {
            Text((member.role ?: "member").capitalizedFirst(), style = OptioTheme.type.caption, color = colors.secondaryLabel)
        }
    }
}

/** A role picker button (iOS menu `Picker`); [onRemove] adds "Remove from workspace". */
@Composable
internal fun RoleMenu(
    role: String,
    onSelect: (String) -> Unit,
    modifier: Modifier = Modifier,
    onRemove: (() -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    Box(modifier) {
        TextButton(onClick = { open = true }) {
            Text(WORKSPACE_ROLES.firstOrNull { it.first == role }?.second ?: role.capitalizedFirst())
            Icon(Icons.Filled.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            WORKSPACE_ROLES.forEach { (value, label) ->
                DropdownMenuItem(
                    text = { Text(label) },
                    leadingIcon = { Icon(roleIcon(value), contentDescription = null) },
                    trailingIcon = if (value == role) {
                        { Icon(Icons.Filled.Check, contentDescription = "Current") }
                    } else {
                        null
                    },
                    onClick = {
                        open = false
                        onSelect(value)
                    },
                )
            }
            if (onRemove != null) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Remove from workspace", color = OptioTheme.colors.red) },
                    leadingIcon = { Icon(Icons.Outlined.PersonRemove, contentDescription = null, tint = OptioTheme.colors.red) },
                    onClick = {
                        open = false
                        onRemove()
                    },
                )
            }
        }
    }
}

/** iOS `roleIcon`: admin shield, viewer eye, member pencil. */
internal fun roleIcon(role: String?) = when (role) {
    "admin" -> Icons.Outlined.Shield
    "viewer" -> Icons.Outlined.Visibility
    else -> Icons.Outlined.Edit
}
