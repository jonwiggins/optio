package dev.optio.feature.library.repos

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.height
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.RepoSettingsRoute
import dev.optio.core.navigation.routes.SharedDirectoriesRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.CheckRow
import dev.optio.feature.library.ConnectionRow
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.McpServerInput
import dev.optio.feature.library.McpServerItem
import dev.optio.feature.library.McpServerRow
import dev.optio.feature.library.McpServerSheet
import dev.optio.feature.library.NavigationRow
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ReviewTriggers
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SharedDirectoryRow
import dev.optio.feature.library.SwipeToDelete
import dev.optio.feature.library.cardPosition
import dev.optio.feature.library.createRepoMcpServer
import dev.optio.feature.library.deleteMcpServer
import dev.optio.feature.library.deleteRepo
import dev.optio.feature.library.getRepo
import dev.optio.feature.library.groupFooter
import dev.optio.feature.library.groupHeader
import dev.optio.feature.library.groupedCard
import dev.optio.feature.library.listOrEmpty
import dev.optio.feature.library.listRepoConnections
import dev.optio.feature.library.listRepoMcpServers
import dev.optio.feature.library.listSharedDirectories
import dev.optio.feature.library.loadStateItems
import dev.optio.feature.library.recycleMessage
import dev.optio.feature.library.recycleRepoPods
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job

/** Everything the repo detail shows (iOS `RepoDetailModel`). */
data class RepoDetail(
    val repo: RepoRow,
    val connections: List<ConnectionRow> = emptyList(),
    val mcpServers: List<McpServerRow> = emptyList(),
    val directories: List<SharedDirectoryRow> = emptyList(),
)

/** One repository (iOS `RepoDetailView`): settings summary, caches, connections, MCP servers, pods. */
class RepoDetailViewModel(private val api: ApiClient, val repoId: String) : LibraryViewModel<RepoDetail>() {
    /** Recycle / remove in flight. */
    var busy by mutableStateOf(false)
        private set

    var mcpSaving by mutableStateOf(false)
        private set

    /** The repo must load; its connections, MCP servers and caches fall back to empty (iOS `try?`). */
    override suspend fun fetch(): RepoDetail {
        val repo = api.getRepo(repoId)
        return coroutineScope {
            val connections = async { listOrEmpty { api.listRepoConnections(repoId) } }
            val servers = async { listOrEmpty { api.listRepoMcpServers(repoId) } }
            val directories = async { listOrEmpty { api.listSharedDirectories(repoId) } }
            RepoDetail(repo, connections.await(), servers.await(), directories.await())
        }
    }

    fun recycle(): Job? {
        if (busy) return null
        busy = true
        return action {
            try {
                toast(recycleMessage(api.recycleRepoPods(repoId)))
            } finally {
                busy = false
            }
        }
    }

    fun delete(): Job? {
        if (busy) return null
        busy = true
        return action {
            try {
                api.deleteRepo(repoId)
                toast("Removed ${state.value.value?.repo?.displayName ?: "the repository"}.")
                close()
            } finally {
                busy = false
            }
        }
    }

    /** Adds a repo-scoped MCP server; [onAdded] closes the sheet. */
    fun addMcpServer(input: McpServerInput, onAdded: () -> Unit): Job? {
        if (mcpSaving) return null
        mcpSaving = true
        return action {
            try {
                api.createRepoMcpServer(repoId, input)
                onAdded()
                toast("Added ${input.name}.")
                reloadQuietly()
            } finally {
                mcpSaving = false
            }
        }
    }

    fun deleteMcpServer(server: McpServerRow) = action {
        api.deleteMcpServer(server.id)
        reloadQuietly()
    }
}

@Composable
internal fun RepoDetailScreen(
    repoId: String,
    vm: RepoDetailViewModel = libraryViewModel { RepoDetailViewModel(it, repoId) },
) {
    val navigator = LocalNavigator.current
    val isAdmin = Roles.isAdmin
    val confirm = rememberConfirmState()
    var showAddMcp by rememberSaveable { mutableStateOf(false) }
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    val name = state.value?.repo?.displayName
    LibraryScaffold(title = name ?: "Repository") { padding ->
        RepoDetailContent(
            state = state,
            isAdmin = isAdmin,
            busy = vm.busy,
            onRefresh = vm::refresh,
            onEditSettings = { navigator.push(RepoSettingsRoute(repoId)) },
            onSharedDirectories = { navigator.push(SharedDirectoriesRoute(repoId)) },
            onOpenConnection = { navigator.push(ConnectionDetailRoute(it.id)) },
            onAddMcp = { showAddMcp = true },
            onDeleteMcp = { server ->
                confirm.ask("Delete MCP server “${server.name ?: ""}”?", confirmLabel = "Delete", destructive = true) {
                    vm.deleteMcpServer(server)
                }
            },
            onRecycle = {
                confirm.ask("Recycle idle pods for ${name ?: "this repo"}?", confirmLabel = "Recycle", onConfirm = vm::recycle)
            },
            onDelete = {
                confirm.ask(
                    "Remove ${name ?: "this repository"} from Optio?",
                    message = "Tasks and settings for this repo will be deleted.",
                    confirmLabel = "Remove",
                    destructive = true,
                    onConfirm = vm::delete,
                )
            },
            contentPadding = padding,
        )
    }
    if (showAddMcp) {
        McpServerSheet(
            repoScoped = true,
            saving = vm.mcpSaving,
            onDismiss = { showAddMcp = false },
            onSave = { input -> vm.addMcpServer(input) { showAddMcp = false } },
        )
    }
    ConfirmHost(confirm)
}

/** iOS `reviewerLabel`: the review agent (override → effective → repo default) and its model. */
internal fun reviewerLabel(repo: RepoRow): String {
    val agent = repo.reviewAgentType ?: repo.effectiveReviewAgentType ?: repo.defaultAgentType ?: "claude-code"
    val model = repo.reviewModel ?: repo.effectiveReviewModel
    return if (model != null) "${AgentTypes.label(agent)} · $model" else AgentTypes.label(agent)
}

/** The repo detail body (stateless). */
@Composable
internal fun RepoDetailContent(
    state: LoadState<RepoDetail>,
    isAdmin: Boolean,
    busy: Boolean,
    onRefresh: () -> Unit,
    onEditSettings: () -> Unit,
    onSharedDirectories: () -> Unit,
    onOpenConnection: (ConnectionRow) -> Unit,
    onAddMcp: () -> Unit,
    onDeleteMcp: (McpServerRow) -> Unit,
    onRecycle: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "repo-detail") {
        loadStateItems(state, what = "repository", onRetry = onRefresh) { detail ->
            val repo = detail.repo
            val agent = repo.defaultAgentType ?: "claude-code"
            groupedCard(key = "info") {
                repo.repoUrl?.let {
                    KeyValueRow("URL", it, mono = true)
                    InsetDivider()
                }
                KeyValueRow("Branch", repo.defaultBranch ?: "main")
                InsetDivider()
                KeyValueRow("Visibility", if (repo.isPrivate == true) "Private" else "Public")
                InsetDivider()
                KeyValueRow("Platform", repo.gitPlatform ?: "github")
                InsetDivider()
                KeyValueRow("Image", repo.imagePreset ?: "base")
            }
            groupedCard(key = "agent", header = "Agent") {
                KeyValueRow("Default agent", AgentTypes.label(agent))
                if (agent == "claude-code") {
                    InsetDivider()
                    KeyValueRow(
                        "Model",
                        "${repo.claudeModel ?: "opus"} · ${repo.claudeContextWindow ?: "1m"} · ${repo.claudeEffort ?: "high"}",
                    )
                }
                InsetDivider()
                KeyValueRow("Max turns", (repo.maxTurnsCoding ?: 250).toString())
            }
            groupedCard(key = "lifecycle", header = "PR lifecycle") {
                CheckRow("Code review", repo.reviewEnabled == true)
                if (repo.reviewEnabled == true) {
                    InsetDivider()
                    KeyValueRow("Trigger", ReviewTriggers.label(repo.reviewTrigger))
                    InsetDivider()
                    KeyValueRow("Reviewer", reviewerLabel(repo))
                }
                InsetDivider()
                CheckRow("Auto-resume", repo.autoResume == true)
                InsetDivider()
                CheckRow("Auto-merge", repo.autoMerge == true)
                InsetDivider()
                CheckRow("Cautious mode", repo.cautiousMode == true)
                InsetDivider()
                CheckRow("Planning mode", repo.planningModeEnabled == true)
            }
            groupedCard(key = "concurrency", header = "Concurrency") {
                KeyValueRow("Max concurrent tasks", (repo.maxConcurrentTasks ?: 2).toString())
                InsetDivider()
                KeyValueRow("Pod instances", (repo.maxPodInstances ?: 1).toString())
                InsetDivider()
                KeyValueRow("Agents per pod", (repo.maxAgentsPerPod ?: 2).toString())
            }
            if (isAdmin) {
                groupedCard(key = "settings") {
                    NavigationRow("Edit settings", onClick = onEditSettings, icon = Icons.Outlined.Tune, modifier = Modifier.testTag("edit-settings"))
                }
            }
            groupedCard(key = "directories", footer = "Persistent per-repo caches (npm, pip, cargo…) mounted into agent pods.") {
                NavigationRow(
                    "Shared directories",
                    onClick = onSharedDirectories,
                    icon = Icons.Outlined.Storage,
                    trailing = detail.directories.size.toString(),
                    modifier = Modifier.testTag("shared-directories"),
                )
            }

            groupHeader("Connections", key = "connections-header")
            if (detail.connections.isEmpty()) {
                // A GroupedRow, not a groupedCard: the header above already gives the air.
                item(key = "connections-empty") {
                    GroupedRow(cardPosition(0, 1)) { NoteRow("No connections assigned to this repo.") }
                }
            } else {
                detail.connections.forEachIndexed { index, connection ->
                    item(key = "connection-${connection.id}") {
                        GroupedRow(cardPosition(index, detail.connections.size)) {
                            OptioRow(
                                title = connection.displayName,
                                tone = if (connection.status == "error") Tone.DANGER else null,
                                meta = metaText(connection.provider?.name),
                                trailing = if (connection.enabled == false) "Paused" else null,
                                titleMaxLines = 1,
                                onClick = { onOpenConnection(connection) },
                            )
                        }
                    }
                }
            }

            groupHeader("MCP servers", key = "mcp-header")
            val servers = detail.mcpServers
            val mcpRows = servers.size + (if (servers.isEmpty()) 1 else 0) + (if (isAdmin) 1 else 0)
            if (servers.isEmpty()) {
                item(key = "mcp-empty") {
                    GroupedRow(cardPosition(0, mcpRows)) { NoteRow("No MCP servers apply to this repo.") }
                }
            }
            servers.forEachIndexed { index, server ->
                item(key = "mcp-${server.id}") {
                    GroupedRow(cardPosition(index, mcpRows)) {
                        SwipeToDelete(enabled = isAdmin && !server.isGlobal, onDelete = { onDeleteMcp(server) }) {
                            McpServerItem(server) {
                                StatusBadge(text = if (server.isGlobal) "global" else "repo", tone = Tone.WORKING)
                                if (server.enabled == false) StatusBadge(text = "disabled", tone = Tone.IDLE)
                            }
                        }
                    }
                }
            }
            if (isAdmin) {
                item(key = "mcp-add") {
                    GroupedRow(cardPosition(mcpRows - 1, mcpRows)) {
                        ActionRow("Add repo MCP server", onClick = onAddMcp, icon = Icons.Outlined.Add, modifier = Modifier.testTag("add-mcp"))
                    }
                }
            }
            groupFooter(
                "Injected into the agent's .mcp.json at runtime. Use \$\u2060{{SECRET_NAME}} to reference Optio secrets.",
                key = "mcp-footer",
            )

            if (isAdmin) {
                groupedCard(
                    key = "admin",
                    footer = "Recycling destroys idle ready pods so they come back with fresh mounts and image settings.",
                ) {
                    ActionRow(
                        "Recycle pods",
                        onClick = onRecycle,
                        icon = Icons.Outlined.Refresh,
                        enabled = !busy,
                        modifier = Modifier.testTag("recycle-pods"),
                    )
                    InsetDivider()
                    ActionRow(
                        "Remove repository",
                        onClick = onDelete,
                        icon = Icons.Outlined.Delete,
                        destructive = true,
                        enabled = !busy,
                        modifier = Modifier.testTag("remove-repo"),
                    )
                }
            }
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
    }
}
