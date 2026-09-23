package dev.optio.feature.library.connections

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.Dot
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.capitalizedFirst
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioColors
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.ChipCloud
import dev.optio.feature.library.ConnectionAssignmentRow
import dev.optio.feature.library.ConnectionRow
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibrarySheet
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SwipeToDelete
import dev.optio.feature.library.cardPosition
import dev.optio.feature.library.createConnectionAssignment
import dev.optio.feature.library.deleteConnection
import dev.optio.feature.library.deleteConnectionAssignment
import dev.optio.feature.library.getConnection
import dev.optio.feature.library.groupFooter
import dev.optio.feature.library.groupHeader
import dev.optio.feature.library.groupedCard
import dev.optio.feature.library.listConnectionAssignments
import dev.optio.feature.library.listOrEmpty
import dev.optio.feature.library.listRepos
import dev.optio.feature.library.loadStateItems
import dev.optio.feature.library.setConnectionEnabled
import dev.optio.feature.library.testConnection
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job

/** One connection with its assignments and the repos that name them (iOS passes the hub's repos). */
data class ConnectionDetail(
    val connection: ConnectionRow,
    val assignments: List<ConnectionAssignmentRow> = emptyList(),
    val repos: List<RepoRow> = emptyList(),
) {
    /** iOS `repoLabel`: null → "All repos", a known repo → its name, else a short id. */
    fun repoLabel(repoId: String?): String {
        if (repoId == null) return "All repos"
        return repos.firstOrNull { it.id == repoId }?.displayName ?: "Repo ${repoId.take(8)}"
    }
}

/**
 * One connection (iOS `ConnectionDetailView`): status, test, enable/disable, assignments, delete.
 * Config values are never shown: the row's `config` is not decoded.
 */
class ConnectionDetailViewModel(private val api: ApiClient, val connectionId: String) : LibraryViewModel<ConnectionDetail>() {
    /** Test / enable / delete in flight. */
    var busy by mutableStateOf(false)
        private set

    var assignmentSaving by mutableStateOf(false)
        private set

    override suspend fun fetch(): ConnectionDetail = coroutineScope {
        val repos = async { listOrEmpty { api.listRepos() } }
        val connection = api.getConnection(connectionId)
        val assignments = connection.assignments ?: listOrEmpty { api.listConnectionAssignments(connectionId) }
        ConnectionDetail(connection, assignments, repos.await())
    }

    private fun busyAction(block: suspend () -> Unit): Job? {
        if (busy) return null
        busy = true
        return action {
            try {
                block()
            } finally {
                busy = false
            }
        }
    }

    /** iOS: "Healthy" / "Failed", plus the server's message. */
    fun test() = busyAction {
        val tested = api.testConnection(connectionId)
        val ok = tested.isHealthy
        toast((if (ok) "Healthy" else "Failed") + (tested.statusMessage?.let { ": $it" } ?: ""), if (ok) Tone.SUCCESS else Tone.DANGER)
        reloadQuietly()
    }

    fun setEnabled(enabled: Boolean) = busyAction {
        api.setConnectionEnabled(connectionId, enabled)
        toast(if (enabled) "Enabled." else "Disabled.")
        reloadQuietly()
    }

    fun delete() = busyAction {
        api.deleteConnection(connectionId)
        toast("Deleted “${state.value.value?.connection?.displayName ?: "connection"}”.")
        close()
    }

    /** Adds an assignment; [onAdded] closes the sheet. */
    fun addAssignment(access: AccessControl, onAdded: () -> Unit): Job? {
        if (assignmentSaving) return null
        assignmentSaving = true
        return action {
            try {
                api.createConnectionAssignment(connectionId, access.assignment())
                onAdded()
                reloadQuietly()
            } finally {
                assignmentSaving = false
            }
        }
    }

    fun deleteAssignment(assignment: ConnectionAssignmentRow) = action {
        api.deleteConnectionAssignment(assignment.id)
        reloadQuietly()
    }
}

@Composable
internal fun ConnectionDetailScreen(
    connectionId: String,
    vm: ConnectionDetailViewModel = libraryViewModel { ConnectionDetailViewModel(it, connectionId) },
) {
    val isAdmin = Roles.isAdmin
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    var showAddAssignment by rememberSaveable { mutableStateOf(false) }
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    val detail = state.value
    LibraryScaffold(title = detail?.connection?.name ?: "Connection") { padding ->
        ConnectionDetailContent(
            state = state,
            isAdmin = isAdmin,
            canMutate = canMutate,
            busy = vm.busy,
            onRefresh = vm::refresh,
            onTest = vm::test,
            onToggleEnabled = { vm.setEnabled(detail?.connection?.enabled == false) },
            onDelete = {
                confirm.ask(
                    "Delete “${detail?.connection?.name ?: "connection"}”?",
                    message = "Assignments are removed too. This cannot be undone.",
                    confirmLabel = "Delete",
                    destructive = true,
                    onConfirm = vm::delete,
                )
            },
            onAddAssignment = { showAddAssignment = true },
            onDeleteAssignment = { assignment ->
                confirm.ask("Remove this assignment?", confirmLabel = "Remove", destructive = true) { vm.deleteAssignment(assignment) }
            },
            contentPadding = padding,
        )
    }
    if (showAddAssignment) {
        LibrarySheet(onDismissRequest = { showAddAssignment = false }, modifier = Modifier.testTag("assignment-sheet")) {
            NewAssignmentForm(
                repos = detail?.repos.orEmpty(),
                saving = vm.assignmentSaving,
                onCancel = { showAddAssignment = false },
                onSave = { access -> vm.addAssignment(access) { showAddAssignment = false } },
            )
        }
    }
    ConfirmHost(confirm)
}

/** iOS `ConnectionIcons.statusColor`: healthy / connected green, error / failed red, else grey. */
internal fun connectionStatusColor(status: String?, colors: OptioColors): Color = when (status) {
    "healthy", "connected" -> colors.green
    "error", "failed" -> colors.red
    else -> colors.grey
}

/** The connection detail body (stateless). */
@Composable
internal fun ConnectionDetailContent(
    state: LoadState<ConnectionDetail>,
    isAdmin: Boolean,
    canMutate: Boolean,
    busy: Boolean,
    onRefresh: () -> Unit,
    onTest: () -> Unit,
    onToggleEnabled: () -> Unit,
    onDelete: () -> Unit,
    onAddAssignment: () -> Unit,
    onDeleteAssignment: (ConnectionAssignmentRow) -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val now = rememberNow()
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "connection-detail") {
        loadStateItems(state, what = "connection", onRetry = onRefresh) { detail ->
            val connection = detail.connection
            groupedCard(key = "status", footer = "Configuration values (tokens, URLs) are write-only and never shown here.") {
                Row(
                    Modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding).testTag("connection-status"),
                    verticalAlignment = Alignment.CenterVertically,
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                ) {
                    Dot(connectionStatusColor(connection.status, OptioTheme.colors), size = 10.dp)
                    Text(
                        connection.status?.capitalizedFirst() ?: "Unknown",
                        style = OptioTheme.type.body,
                        color = OptioTheme.colors.label,
                        modifier = Modifier.weight(1f),
                    )
                    connection.lastCheckedAt?.isoInstant()?.let {
                        Text("checked ${it.relativeDescription(now)}", style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
                    }
                }
                connection.statusMessage?.takeIf { it.isNotEmpty() }?.let {
                    InsetDivider()
                    NoteRow(it)
                }
                connection.provider?.let { provider ->
                    InsetDivider()
                    KeyValueRow("Provider", provider.name ?: provider.slug ?: "")
                    provider.type?.let {
                        InsetDivider()
                        KeyValueRow("Type", it.uppercase())
                    }
                }
                InsetDivider()
                KeyValueRow(
                    "Scope",
                    if (connection.scope == null || connection.scope == "global") "Global" else connection.repoUrl ?: connection.scope,
                    mono = connection.scope != null && connection.scope != "global",
                )
                InsetDivider()
                KeyValueRow("Enabled", if (connection.enabled == false) "No" else "Yes")
                connection.createdAt?.isoInstant()?.let {
                    InsetDivider()
                    KeyValueRow("Created", it.relativeDescription(now))
                }
            }
            connection.provider?.capabilities?.takeIf { it.isNotEmpty() }?.let { capabilities ->
                groupedCard(key = "capabilities", header = "Capabilities") { ChipCloud(capabilities) }
            }

            groupHeader("Assignments", key = "assignments-header")
            val assignments = detail.assignments
            val rows = assignments.size + (if (assignments.isEmpty()) 1 else 0) + (if (canMutate) 1 else 0)
            if (assignments.isEmpty()) {
                item(key = "assignments-empty") {
                    GroupedRow(cardPosition(0, rows)) { NoteRow("No assignments — this connection is not injected anywhere.") }
                }
            }
            assignments.forEachIndexed { index, assignment ->
                item(key = "assignment-${assignment.id}") {
                    GroupedRow(cardPosition(index, rows)) {
                        SwipeToDelete(enabled = canMutate, onDelete = { onDeleteAssignment(assignment) }, label = "Remove") {
                            AssignmentItem(assignment, detail.repoLabel(assignment.repoId))
                        }
                    }
                }
            }
            if (canMutate) {
                item(key = "assignment-add") {
                    GroupedRow(cardPosition(rows - 1, rows)) {
                        ActionRow("Add assignment", onClick = onAddAssignment, icon = Icons.Outlined.Add, modifier = Modifier.testTag("add-assignment"))
                    }
                }
            }
            groupFooter("Which repos and agent types receive this connection, and with what permission.", key = "assignments-footer")

            if (isAdmin) {
                groupedCard(key = "actions") {
                    ActionRow("Test connection", onClick = onTest, icon = Icons.Outlined.Bolt, enabled = !busy, modifier = Modifier.testTag("test-connection"))
                    InsetDivider()
                    val paused = connection.enabled == false
                    ActionRow(
                        if (paused) "Enable" else "Disable",
                        onClick = onToggleEnabled,
                        icon = if (paused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
                        enabled = !busy,
                        modifier = Modifier.testTag("toggle-connection"),
                    )
                    InsetDivider()
                    ActionRow(
                        "Delete connection",
                        onClick = onDelete,
                        icon = Icons.Outlined.Delete,
                        destructive = true,
                        enabled = !busy,
                        modifier = Modifier.testTag("delete-connection"),
                    )
                }
            }
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
    }
}

/** One assignment (iOS: repo, permission + "off" badges, then the agents). */
@Composable
internal fun AssignmentItem(assignment: ConnectionAssignmentRow, repoLabel: String, modifier: Modifier = Modifier) {
    val colors = OptioTheme.colors
    val agents = assignment.agentTypes.orEmpty()
    Column(
        modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding).testTag("assignment-${assignment.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(repoLabel, style = OptioTheme.type.subheadline, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
            StatusBadge(text = assignment.permission ?: "read", tone = Tone.ACCENT)
            if (assignment.enabled == false) StatusBadge(text = "off", tone = Tone.IDLE)
        }
        Text(
            if (agents.isEmpty()) "All agents" else agents.joinToString(", ") { AgentTypes.label(it) },
            style = OptioTheme.type.caption,
            color = colors.secondaryLabel,
        )
    }
}
