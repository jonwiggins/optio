package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.semibold

/**
 * The identity dot every paired server carries (iOS `ServerDot`): the same size as the state dot
 * so it sits in rows and chips without shifting the baseline. [color] is `ServerColor.argb` from
 * `:core:data` as a Compose colour (see the `argb` overload).
 */
@Composable
fun ServerDot(
    color: Color,
    modifier: Modifier = Modifier,
    size: Dp = 8.dp,
) {
    Dot(color = color, size = size, modifier = modifier)
}

/** [ServerDot] for a packed ARGB value (`ServerColor.argb`). */
@Composable
fun ServerDot(
    argb: Long,
    modifier: Modifier = Modifier,
    size: Dp = 8.dp,
) {
    ServerDot(color = Color(argb), modifier = modifier, size = size)
}

/**
 * Dot + name capsule (iOS `ServerChip`): the current server, wherever the user needs to know which
 * machine a screen talks to. [prominent] adds the menu chevron; [switching] dims it under a
 * spinner while a server switch is in flight.
 */
@Composable
fun ServerChip(
    name: String,
    color: Color,
    modifier: Modifier = Modifier,
    prominent: Boolean = false,
    switching: Boolean = false,
) {
    Box(modifier, contentAlignment = Alignment.Center) {
        Row(
            modifier = Modifier
                .alpha(if (switching) 0.4f else 1f)
                .clip(Radius.capsuleShape)
                .background(color.copy(alpha = 0.12f))
                .padding(horizontal = 10.dp, vertical = 5.dp),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(6.dp),
        ) {
            ServerDot(color)
            Text(name, style = OptioTheme.type.footnote.semibold(), color = OptioTheme.colors.label, maxLines = 1)
            if (prominent) {
                Icon(Icons.Filled.ExpandMore, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(16.dp))
            }
        }
        if (switching) CircularProgressIndicator(Modifier.size(14.dp), strokeWidth = 2.dp)
    }
}

/** One paired server as the switcher shows it (a projection of `ServerProfile`). */
@Immutable
data class ServerOption(
    val id: String,
    /** Display name (`ServerProfile.name`). */
    val name: String,
    /** Host for the menu's second line (`ServerProfile.host`). */
    val host: String,
    /** `ServerColor` as a Compose colour: `Color(profile.color.argb)`. */
    val color: Color,
    /** Label for tight spaces (`ServerProfile.shortName`); defaults to [name]. */
    val shortName: String = name,
)

/**
 * The hub top-bar control that names the active server and switches between the paired ones (iOS
 * `ServerSwitcherMenu`), stateless: the caller passes the servers and handles the callbacks. With
 * one server it still names it (no chevron) and the menu offers Add / Manage. Test tags:
 * `server-switcher`, `server-<id>`, `add-server`, `manage-servers`.
 */
@Composable
fun ServerSwitcherChip(
    active: ServerOption,
    servers: List<ServerOption>,
    onSwitch: (id: String) -> Unit,
    onAddServer: () -> Unit,
    onManageServers: () -> Unit,
    modifier: Modifier = Modifier,
    switching: Boolean = false,
) {
    var expanded by remember { mutableStateOf(false) }
    Box(modifier) {
        ServerChip(
            name = active.shortName,
            color = active.color,
            prominent = servers.size > 1,
            switching = switching,
            modifier = Modifier
                .clip(Radius.capsuleShape)
                .clickable(enabled = !switching, role = Role.Button, onClickLabel = "Switch between paired servers") { expanded = true }
                .semantics { contentDescription = "Server: ${active.name}" }
                .testTag("server-switcher"),
        )
        DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            Text(
                "Connected to",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.padding(horizontal = 16.dp, vertical = 8.dp),
            )
            servers.forEach { server ->
                DropdownMenuItem(
                    text = {
                        Column {
                            Text(server.name, style = OptioTheme.type.body, maxLines = 1)
                            Text(server.host, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel, maxLines = 1)
                        }
                    },
                    leadingIcon = { ServerDot(server.color) },
                    trailingIcon = if (server.id == active.id) {
                        { Icon(Icons.Filled.Check, contentDescription = "Active") }
                    } else {
                        null
                    },
                    onClick = {
                        expanded = false
                        if (server.id != active.id) onSwitch(server.id)
                    },
                    modifier = Modifier.testTag("server-${server.id}"),
                )
            }
            HorizontalDivider()
            DropdownMenuItem(
                text = { Text("Add server…") },
                leadingIcon = { Icon(Icons.Outlined.Add, contentDescription = null) },
                onClick = {
                    expanded = false
                    onAddServer()
                },
                modifier = Modifier.testTag("add-server"),
            )
            DropdownMenuItem(
                text = { Text("Manage servers…") },
                leadingIcon = { Icon(Icons.Outlined.Tune, contentDescription = null) },
                onClick = {
                    expanded = false
                    onManageServers()
                },
                modifier = Modifier.testTag("manage-servers"),
            )
        }
    }
}
