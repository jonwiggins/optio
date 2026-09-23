package dev.optio.feature.sessions

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.optio.core.terminal.TerminalKeyBar
import dev.optio.core.terminal.TerminalState
import dev.optio.core.terminal.TerminalSurface
import dev.optio.core.terminal.TerminalTheme
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold

/**
 * The session's shell (iOS `SessionTerminalView`): an error strip when the socket failed (with
 * Reconnect once it gave up), the terminal fitted to the phone (the phone owns this grid, so the PTY
 * follows the view), and the extra-keys bar. The screen pads the whole column above the keyboard.
 */
@Composable
internal fun SessionTerminalView(
    terminal: TerminalState,
    ui: SessionTerminalUi,
    onReconnect: () -> Unit,
    modifier: Modifier = Modifier,
    focusOnShow: Boolean = true,
) {
    val dark = OptioTheme.colors.isDark
    Column(modifier.background(TerminalTheme.background(dark)).testTag("session-terminal")) {
        val error = ui.error
        if (error != null || ui.stopped) {
            Row(
                Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.xs, top = Spacing.xs, bottom = Spacing.xs).testTag("terminal-error"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = OptioTheme.colors.red, modifier = Modifier.size(16.dp))
                Text(
                    error ?: "Disconnected.",
                    style = OptioTheme.type.footnote,
                    color = TerminalTheme.foreground(dark).copy(alpha = 0.7f),
                    modifier = Modifier.weight(1f),
                )
                if (ui.stopped) {
                    TextButton(onClick = onReconnect, modifier = Modifier.testTag("terminal-reconnect")) {
                        Text("Reconnect", style = OptioTheme.type.footnote.semibold())
                    }
                }
            }
        }
        TerminalSurface(terminal, Modifier.weight(1f).fillMaxWidth(), dark = dark)
        TerminalKeyBar(terminal, enabled = ui.connected, dark = dark)
    }
    // iOS makes the session terminal first responder: the keyboard comes up with it.
    if (focusOnShow) LaunchedEffect(terminal) { terminal.focus() }
}
