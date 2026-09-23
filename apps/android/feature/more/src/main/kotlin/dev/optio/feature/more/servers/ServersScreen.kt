package dev.optio.feature.more.servers

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AddServerRoute
import dev.optio.core.navigation.routes.ServerEditRoute
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `ServersRoute` (iOS `ServersView`). */
@Composable
fun ServersScreen() {
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel { ServersViewModel(session) }
    val servers by session.servers.collectAsStateWithLifecycle()
    val active by session.activeServer.collectAsStateWithLifecycle()
    val probes by viewModel.probes.collectAsStateWithLifecycle()
    LaunchedEffect(viewModel, servers.map { it.id to it.url }) { viewModel.probeAll(servers) }
    MoreScaffold("Servers") { padding ->
        ServersContent(
            servers = servers,
            activeId = active?.id,
            probes = probes,
            contentPadding = padding,
            onRefresh = { viewModel.probeAll(servers) },
            onSelect = { if (it.id != active?.id) viewModel.switchTo(it.id) },
            onEdit = { navigator.push(ServerEditRoute(it.id)) },
            onForget = { viewModel.forget(it.id) },
            onAdd = { navigator.push(AddServerRoute) },
        )
    }
}

/** The paired servers, stateless. */
@Composable
fun ServersContent(
    servers: List<ServerProfile>,
    activeId: String?,
    probes: Map<String, ServerProbe>,
    contentPadding: PaddingValues,
    onRefresh: suspend () -> Unit,
    onSelect: (ServerProfile) -> Unit,
    onEdit: (ServerProfile) -> Unit,
    onForget: (ServerProfile) -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val confirm = rememberConfirmState()
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("servers"), contentPadding = contentPadding) {
            groupedItem(
                "paired",
                header = "Paired servers",
                footer = "Tap a server to switch the whole app to it; Edit changes its name, colour and address. Widgets can show one server or all of them.",
            ) {
                servers.forEachIndexed { index, server ->
                    if (index > 0) InsetDivider(start = 44.dp)
                    ServerRow(
                        server = server,
                        isActive = server.id == activeId,
                        probe = probes[server.id],
                        onSelect = { onSelect(server) },
                        onEdit = { onEdit(server) },
                        onForget = {
                            confirm.ask(
                                title = "Forget ${server.name}?",
                                message = "Its access token is removed from this phone. Nothing changes on the server.",
                                confirmLabel = "Forget server",
                                destructive = true,
                            ) { onForget(server) }
                        },
                    )
                }
            }
            groupedItem("add") {
                SettingsRow("Add server", icon = Icons.Outlined.Add, tint = OptioTheme.colors.accent, chevron = false, onClick = onAdd, modifier = Modifier.testTag("servers-add"))
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** One server (iOS `ServerRow`): dot, name, host, probe state; tap switches, Edit edits, long-press offers Forget. */
@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun ServerRow(
    server: ServerProfile,
    isActive: Boolean,
    probe: ServerProbe?,
    onSelect: () -> Unit,
    onEdit: () -> Unit,
    onForget: () -> Unit,
) {
    val colors = OptioTheme.colors
    var menu by remember { mutableStateOf(false) }
    Box {
        Row(
            Modifier
                .fillMaxWidth()
                .combinedClickable(role = Role.Button, onClickLabel = "Switch to ${server.name}", onClick = onSelect, onLongClick = { menu = true })
                .padding(horizontal = Spacing.l, vertical = Spacing.m)
                .semantics(mergeDescendants = true) {
                    contentDescription = "${server.name}, ${probe?.label ?: "checking"}${if (isActive) ", current" else ""}"
                }
                .testTag("server-row-${server.id}"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            ServerDot(Color(server.color.argb), size = 12.dp)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(server.name, style = OptioTheme.type.body, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                Text(server.host, style = OptioTheme.type.monoFootnote, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
                Row(horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                    if (probe != null) {
                        Text(probe.label, style = OptioTheme.type.caption, color = probe.tone.textColor, maxLines = 1)
                        probe.user?.let { Text("· $it", style = OptioTheme.type.caption, color = colors.tertiaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) }
                    } else {
                        Text("Checking…", style = OptioTheme.type.caption, color = colors.tertiaryLabel)
                    }
                }
            }
            if (isActive) Icon(Icons.Filled.Check, contentDescription = null, tint = colors.accent)
            OutlinedButton(
                onClick = onEdit,
                contentPadding = PaddingValues(horizontal = 12.dp, vertical = 0.dp),
                modifier = Modifier.testTag("server-edit-${server.id}"),
            ) {
                Text("Edit", style = OptioTheme.type.footnote.semibold())
            }
        }
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            DropdownMenuItem(
                text = { Text("Edit name, colour, URL") },
                leadingIcon = { Icon(Icons.Outlined.Edit, contentDescription = null) },
                onClick = {
                    menu = false
                    onEdit()
                },
            )
            DropdownMenuItem(
                text = { Text("Forget", color = colors.red) },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = colors.red) },
                onClick = {
                    menu = false
                    onForget()
                },
                modifier = Modifier.testTag("server-forget-${server.id}"),
            )
        }
    }
}
