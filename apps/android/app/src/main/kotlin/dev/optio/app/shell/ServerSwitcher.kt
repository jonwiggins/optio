package dev.optio.app.shell

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.KeyboardArrowDown
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AddServerRoute
import dev.optio.core.navigation.routes.ServersRoute
import kotlinx.coroutines.launch

/**
 * The hub top bar's server control (iOS `ServerSwitcherMenu`): a chip naming the active server
 * (colour dot + short name, a chevron when several are paired, "Switching…" while a switch is in
 * flight) that opens a menu of the paired servers (check on the active one; tap to switch), then
 * "Add server…" ([AddServerRoute]) and "Manage servers…" ([ServersRoute]).
 */
@Composable
internal fun ServerSwitcherMenu(modifier: Modifier = Modifier) {
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val active by session.activeServer.collectAsStateWithLifecycle()
    val servers by session.servers.collectAsStateWithLifecycle()
    val switching by session.switching.collectAsStateWithLifecycle()
    val server = active ?: return
    var expanded by remember { mutableStateOf(false) }
    val scope = rememberCoroutineScope()

    Box(modifier) {
        ServerChip(
            server = server,
            prominent = servers.size > 1,
            switching = switching,
            onClick = { expanded = true },
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Text(
                "Connected to",
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            servers.forEach { item ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(item.name, maxLines = 1, overflow = TextOverflow.Ellipsis)
                            Text(
                                item.host,
                                style = MaterialTheme.typography.bodySmall,
                                color = MaterialTheme.colorScheme.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    leadingIcon = { ServerDot(item.color) },
                    trailingIcon = {
                        if (item.id == server.id) Icon(Icons.Filled.Check, contentDescription = "Active")
                    },
                    onClick = {
                        expanded = false
                        scope.launch { session.switchTo(item.id) }
                    },
                    modifier = Modifier.widthIn(min = 220.dp).testTag("server-${item.id}"),
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("Add server…") },
                leadingIcon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                onClick = {
                    expanded = false
                    navigator.push(AddServerRoute)
                },
                modifier = Modifier.testTag("add-server"),
            )
            DropdownMenuItem(
                text = { Text("Manage servers…") },
                leadingIcon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                onClick = {
                    expanded = false
                    navigator.push(ServersRoute)
                },
                modifier = Modifier.testTag("manage-servers"),
            )
        }
    }
}

/** Dot + name capsule tinted with the server's colour (iOS `ServerChip`). */
@Composable
private fun ServerChip(
    server: ServerProfile,
    prominent: Boolean,
    switching: Boolean,
    onClick: () -> Unit,
) {
    val tint = Color(server.color.argb)
    Surface(
        onClick = onClick,
        shape = CircleShape,
        color = tint.copy(alpha = 0.12f),
        contentColor = MaterialTheme.colorScheme.onSurface,
        modifier =
            Modifier
                .padding(horizontal = 4.dp)
                .testTag("server-switcher")
                .semantics {
                    contentDescription = "Server: ${server.name}"
                    if (switching) stateDescription = "Switching…"
                },
    ) {
        Row(
            modifier = Modifier.padding(horizontal = 10.dp, vertical = 5.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            if (switching) {
                CircularProgressIndicator(modifier = Modifier.size(10.dp), strokeWidth = 1.5.dp)
            } else {
                ServerDot(server.color)
            }
            Text(
                if (switching) "Switching…" else server.shortName,
                style = MaterialTheme.typography.labelLarge,
                fontWeight = FontWeight.SemiBold,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.widthIn(max = 160.dp),
            )
            if (prominent) {
                Icon(
                    Icons.Filled.KeyboardArrowDown,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(16.dp),
                )
            }
        }
    }
}

/**
 * A server's identity dot (iOS `ServerDot`). Local to the app for now; `:core:ui` gets the shared
 * `ServerDot` / `ServerSwitcherChip` (agent U), and the two are unified at merge.
 */
@Composable
internal fun ServerDot(
    color: ServerColor,
    size: Dp = 8.dp,
) {
    Box(Modifier.size(size).background(Color(color.argb), CircleShape))
}
