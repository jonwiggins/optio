package dev.optio.app.shell

import androidx.compose.foundation.layout.padding
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AddServerRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.ui.components.ServerOption
import dev.optio.core.ui.components.ServerSwitcherChip
import kotlinx.coroutines.launch

/**
 * The hub top bar's server control (iOS `ServerSwitcherMenu`): `:core:ui`'s stateless
 * [ServerSwitcherChip] over the [dev.optio.core.data.SessionStore]. Tapping a server switches the
 * whole app to it; "Add server…" opens [AddServerRoute], "Manage servers…" [ServersRoute]. The chip
 * dims under a spinner while a switch is in flight.
 */
@Composable
internal fun HubServerSwitcher(modifier: Modifier = Modifier) {
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val active by session.activeServer.collectAsStateWithLifecycle()
    val servers by session.servers.collectAsStateWithLifecycle()
    val switching by session.switching.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    val current = active ?: return
    ServerSwitcherChip(
        active = current.option(),
        servers = servers.map { it.option() },
        // switchTo runs in the session's scope, so it finishes although it rebuilds this shell.
        onSwitch = { id -> scope.launch { session.switchTo(id) } },
        onAddServer = { navigator.push(AddServerRoute) },
        onManageServers = { navigator.push(ServersRoute) },
        switching = switching,
        modifier = modifier.padding(horizontal = 4.dp),
    )
}

private fun ServerProfile.option() = ServerOption(id = id, name = name, host = host, color = Color(color.argb), shortName = shortName)
