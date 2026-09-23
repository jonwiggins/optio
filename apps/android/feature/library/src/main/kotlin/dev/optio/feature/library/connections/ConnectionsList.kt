package dev.optio.feature.library.connections

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AddCircleOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.NewConnectionRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.ConnectionProviderRow
import dev.optio.feature.library.ConnectionRow
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.McpServerInput
import dev.optio.feature.library.McpServerItem
import dev.optio.feature.library.McpServerRow
import dev.optio.feature.library.McpServerSheet
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.OtherProviderCategory
import dev.optio.feature.library.ProviderCategories
import dev.optio.feature.library.ProviderCategory
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SwipeToDelete
import dev.optio.feature.library.cardPosition
import dev.optio.feature.library.createMcpServer
import dev.optio.feature.library.deleteConnection
import dev.optio.feature.library.deleteMcpServer
import dev.optio.feature.library.groupFooter
import dev.optio.feature.library.groupHeader
import dev.optio.feature.library.listConnectionProviders
import dev.optio.feature.library.listConnections
import dev.optio.feature.library.listMcpServers
import dev.optio.feature.library.listOrEmpty
import dev.optio.feature.library.listRepos
import dev.optio.feature.library.loadStateItems
import dev.optio.feature.library.providerIcon
import dev.optio.feature.library.setMcpServerEnabled
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job

/** What the Connections hub shows (iOS `ConnectionsModel`). */
data class ConnectionsCatalog(
    val connections: List<ConnectionRow> = emptyList(),
    val providers: List<ConnectionProviderRow> = emptyList(),
    /** Global MCP servers. */
    val mcpServers: List<McpServerRow> = emptyList(),
    val repos: List<RepoRow> = emptyList(),
) {
    /** The connection's provider: embedded, else from the catalogue. */
    fun provider(connection: ConnectionRow): ConnectionProviderRow? =
        connection.provider ?: providers.firstOrNull { it.id == connection.providerId }

    /** Providers by category in the catalogue order; unknown categories land in "Other". */
    internal val groupedProviders: List<Pair<ProviderCategory, List<ConnectionProviderRow>>>
        get() {
            val groups = ProviderCategories.mapNotNull { category ->
                providers.filter { it.category == category.key }.takeIf { it.isNotEmpty() }?.let { category to it }
            }
            val known = ProviderCategories.map { it.key }.toSet()
            val other = providers.filter { it.category !in known }
            return if (other.isEmpty()) groups else groups + (OtherProviderCategory to other)
        }
}

/**
 * Library › Connections: active connections, the provider catalogue (tap to add) and global MCP
 * servers — what the web's Connections + Settings pages expose for agent integrations.
 */
class ConnectionsViewModel(private val api: ApiClient) : LibraryViewModel<ConnectionsCatalog>() {
    var mcpSaving by mutableStateOf(false)
        private set

    /**
     * iOS loads all four at once and only shows an error when connections failed and there is no
     * catalogue either; the rest fall back to empty.
     */
    override suspend fun fetch(): ConnectionsCatalog = coroutineScope {
        val providers = async { listOrEmpty { api.listConnectionProviders() } }
        val servers = async { listOrEmpty { api.listMcpServers(scope = "global") } }
        val repos = async { listOrEmpty { api.listRepos() } }
        val connections = try {
            Result.success(api.listConnections())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
        val catalogue = providers.await()
        connections.exceptionOrNull()?.let { if (catalogue.isEmpty()) throw it }
        ConnectionsCatalog(connections.getOrDefault(emptyList()), catalogue, servers.await(), repos.await())
    }

    fun deleteConnection(connection: ConnectionRow) = action {
        api.deleteConnection(connection.id)
        toast("Deleted “${connection.displayName}”.")
        reloadQuietly()
    }

    /** Flips a global MCP server right away (iOS waits for the reload); reverts when the server refuses. */
    fun setMcpEnabled(server: McpServerRow, enabled: Boolean): Job? {
        val before = state.value.value ?: return null
        replaceValue(before.copy(mcpServers = before.mcpServers.map { if (it.id == server.id) it.copy(enabled = enabled) else it }))
        return action {
            try {
                api.setMcpServerEnabled(server.id, enabled)
            } catch (e: Exception) {
                if (e is CancellationException) throw e
                state.value.value?.let { now ->
                    replaceValue(now.copy(mcpServers = now.mcpServers.map { if (it.id == server.id) it.copy(enabled = server.enabled) else it }))
                }
                throw e
            }
            reloadQuietly()
        }
    }

    fun deleteMcpServer(server: McpServerRow) = action {
        api.deleteMcpServer(server.id)
        reloadQuietly()
    }

    /** Adds a global MCP server; [onAdded] closes the sheet. */
    fun addMcpServer(input: McpServerInput, onAdded: () -> Unit): Job? {
        if (mcpSaving) return null
        mcpSaving = true
        return action {
            try {
                api.createMcpServer(input)
                onAdded()
                toast("Added ${input.name}.")
                reloadQuietly()
            } finally {
                mcpSaving = false
            }
        }
    }
}

@Composable
internal fun ConnectionsScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    vm: ConnectionsViewModel = libraryViewModel { ConnectionsViewModel(it) },
) {
    val navigator = LocalNavigator.current
    val isAdmin = Roles.isAdmin
    val confirm = rememberConfirmState()
    var showAddMcp by rememberSaveable { mutableStateOf(false) }
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    ConnectionsContent(
        state = state,
        isAdmin = isAdmin,
        onRefresh = vm::refresh,
        onOpenConnection = { navigator.push(ConnectionDetailRoute(it.id)) },
        onDeleteConnection = { connection ->
            confirm.ask(
                "Delete connection “${connection.displayName}”?",
                message = "This cannot be undone.",
                confirmLabel = "Delete",
                destructive = true,
            ) { vm.deleteConnection(connection) }
        },
        onAddConnection = { navigator.push(NewConnectionRoute(it.id)) },
        onSetMcpEnabled = vm::setMcpEnabled,
        onDeleteMcp = { server ->
            confirm.ask("Delete MCP server “${server.name ?: ""}”?", confirmLabel = "Delete", destructive = true) {
                vm.deleteMcpServer(server)
            }
        },
        onAddMcp = { showAddMcp = true },
        contentPadding = contentPadding,
        modifier = modifier,
    )
    if (showAddMcp) {
        McpServerSheet(
            repoScoped = false,
            saving = vm.mcpSaving,
            onDismiss = { showAddMcp = false },
            onSave = { input -> vm.addMcpServer(input) { showAddMcp = false } },
        )
    }
    ConfirmHost(confirm)
}

/** The Connections hub body (stateless). */
@Composable
internal fun ConnectionsContent(
    state: LoadState<ConnectionsCatalog>,
    isAdmin: Boolean,
    onRefresh: () -> Unit,
    onOpenConnection: (ConnectionRow) -> Unit,
    onDeleteConnection: (ConnectionRow) -> Unit,
    onAddConnection: (ConnectionProviderRow) -> Unit,
    onSetMcpEnabled: (McpServerRow, Boolean) -> Unit,
    onDeleteMcp: (McpServerRow) -> Unit,
    onAddMcp: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "connections-list") {
        loadStateItems(state, what = "connections", onRetry = onRefresh) { catalog ->
            groupHeader("Active connections", key = "active-header", detail = catalog.connections.size.toString())
            if (catalog.connections.isEmpty()) {
                item(key = "active-empty") {
                    GroupedRow(cardPosition(0, 1)) { NoteRow("No connections yet. Pick a provider below to add one.") }
                }
            } else {
                catalog.connections.forEachIndexed { index, connection ->
                    item(key = "connection-${connection.id}") {
                        GroupedRow(cardPosition(index, catalog.connections.size)) {
                            SwipeToDelete(enabled = isAdmin, onDelete = { onDeleteConnection(connection) }) {
                                ConnectionListRow(connection, catalog.provider(connection), onClick = { onOpenConnection(connection) })
                            }
                        }
                    }
                }
            }

            catalog.groupedProviders.forEach { (category, providers) ->
                item(key = "category-${category.key}") { ProviderCategoryHeader(category) }
                providers.forEachIndexed { index, provider ->
                    item(key = "provider-${provider.id}") {
                        GroupedRow(cardPosition(index, providers.size)) {
                            ProviderRow(provider, isAdmin = isAdmin, onClick = { onAddConnection(provider) })
                        }
                    }
                }
            }

            groupHeader("Global MCP servers", key = "mcp-header")
            val servers = catalog.mcpServers
            val mcpRows = servers.size + (if (servers.isEmpty()) 1 else 0) + (if (isAdmin) 1 else 0)
            if (servers.isEmpty()) {
                item(key = "mcp-empty") {
                    GroupedRow(cardPosition(0, mcpRows)) { NoteRow("No global MCP servers.") }
                }
            }
            servers.forEachIndexed { index, server ->
                item(key = "mcp-${server.id}") {
                    GroupedRow(cardPosition(index, mcpRows)) {
                        SwipeToDelete(enabled = isAdmin, onDelete = { onDeleteMcp(server) }) {
                            McpServerItem(server) {
                                if (isAdmin) {
                                    Switch(
                                        checked = server.enabled ?: true,
                                        onCheckedChange = { onSetMcpEnabled(server, it) },
                                        modifier = Modifier.testTag("mcp-toggle-${server.id}"),
                                    )
                                } else if (server.enabled == false) {
                                    StatusBadge(text = "Paused", tone = Tone.IDLE)
                                }
                            }
                        }
                    }
                }
            }
            if (isAdmin) {
                item(key = "mcp-add") {
                    GroupedRow(cardPosition(mcpRows - 1, mcpRows)) {
                        ActionRow("Add global MCP server", onClick = onAddMcp, icon = Icons.Outlined.Add, modifier = Modifier.testTag("add-mcp"))
                    }
                }
            }
            groupFooter("Applied to every repo's agent pods. Repo-scoped servers live on each repo's page.", key = "mcp-footer")
            item(key = "bottom") { Spacer(Modifier.height(24.dp)) }
        }
    }
}

/** One connection (iOS `connectionRow`): name; provider · status (unless healthy) · checked when. */
@Composable
internal fun ConnectionListRow(
    connection: ConnectionRow,
    provider: ConnectionProviderRow?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val now = rememberNow()
    OptioRow(
        title = connection.displayName,
        tone = if (connection.isFailing) Tone.DANGER else null,
        meta = metaText(
            provider?.name,
            connection.status?.takeUnless { connection.isHealthy },
            connection.lastCheckedAt?.isoInstant()?.let { "checked ${it.relativeDescription(now)}" },
        ),
        trailing = if (connection.enabled == false) "Paused" else null,
        titleMaxLines = 1,
        onClick = onClick,
        modifier = modifier.testTag("connection-${connection.id}"),
    )
}

/** A catalogue category header with its glyph (iOS `Label(group, systemImage:)`). */
@Composable
internal fun ProviderCategoryHeader(category: ProviderCategory, modifier: Modifier = Modifier) {
    Row(
        modifier.fillMaxWidth().padding(start = Spacing.l * 2, end = Spacing.l * 2, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(category.icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(16.dp))
        SectionHeader(category.label, contentPadding = PaddingValues(0.dp))
    }
}

/**
 * A catalogue provider (iOS: glyph, name, description, a "+" for admins). Only admins can add a
 * connection, so the row is disabled for everyone else.
 */
@Composable
internal fun ProviderRow(
    provider: ConnectionProviderRow,
    isAdmin: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .clickable(enabled = isAdmin, role = Role.Button, onClickLabel = "Add connection", onClick = onClick)
            .padding(OptioRowDefaults.ContentPadding)
            .testTag("provider-${provider.slug ?: provider.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(providerIcon(provider.icon), contentDescription = null, tint = colors.accent, modifier = Modifier.size(24.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(provider.displayName, style = OptioTheme.type.subheadline, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(
                provider.description ?: "Connect to ${provider.name ?: "service"}",
                style = OptioTheme.type.caption,
                color = colors.secondaryLabel,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (isAdmin) Icon(Icons.Outlined.AddCircleOutline, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(22.dp))
    }
}
