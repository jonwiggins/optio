package dev.optio.feature.local.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Adjust
import androidx.compose.material.icons.outlined.CallMerge
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.luminance
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.mono
import dev.optio.feature.local.model.LocalPresentation

/** Whether the app theme around us is dark (the terminal follows the app's appearance, not the system's). */
@Composable
@ReadOnlyComposable
internal fun optioIsDark(): Boolean = OptioTheme.colors.page.luminance() < 0.5f

/** The icon a work link wears: a PR, a ticket, a bare `#123` reference. */
internal val WorkLink.icon: ImageVector
    get() =
        when (kind) {
            WorkLinkKind.PR -> Icons.Outlined.CallMerge
            WorkLinkKind.REF -> Icons.Outlined.Tag
            else -> Icons.Outlined.Adjust
        }

/**
 * Small chips for a terminal's PR / ticket links (iOS `WorkLinkBadges`, web `work-links.tsx`): the
 * number only (`PR #519`), the kind in the icon; a tap opens the link. At most [max], then `+N`.
 */
@Composable
internal fun WorkLinkBadges(
    links: List<WorkLink>,
    onOpen: (String) -> Unit,
    modifier: Modifier = Modifier,
    max: Int = 3,
) {
    if (links.isEmpty()) return
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(4.dp), verticalAlignment = Alignment.CenterVertically) {
        links.take(max).forEach { link ->
            Row(
                Modifier
                    .background(colors.fillTertiary, Radius.smallShape)
                    .clickable(role = Role.Button, onClickLabel = "Open ${link.label}") { onOpen(link.url) }
                    .padding(horizontal = 6.dp, vertical = 3.dp)
                    .testTag("work-link"),
                horizontalArrangement = Arrangement.spacedBy(3.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Icon(link.icon, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(12.dp))
                Text(LocalPresentation.shortLinkLabel(link), style = type.caption2.mono(), color = colors.secondaryLabel, maxLines = 1)
            }
        }
        if (links.size > max) {
            Text("+${links.size - max}", style = type.caption2.mono(), color = colors.tertiaryLabel)
        }
    }
}

/**
 * One terminal row (iOS `TerminalRowView`): state dot, title, `host · dir · command`, trailing
 * activity time or attention reason, and a footer with the error or the work links.
 */
@Composable
internal fun TerminalRow(
    terminal: LocalTerminal,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    hostName: String? = null,
) {
    val now = LocalClock.current.instant()
    val needsYou = LocalPresentation.waitsOnYou(terminal)
    val (trailing, trailingTone) =
        when {
            needsYou -> LocalPresentation.waitingLabel(terminal) to Tone.ACCENT
            terminal.state == LocalTerminalState.ERROR -> "Error" to Tone.DANGER
            terminal.state == LocalTerminalState.EXITED && (terminal.exitCode ?: 0.0) != 0.0 -> "exit ${terminal.exitCode?.toInt()}" to Tone.DANGER
            terminal.state == LocalTerminalState.EXITED -> "Finished" to null
            terminal.state == LocalTerminalState.PENDING ->
                (if (terminal.pendingReason == LocalTerminalPendingReason.HOST_OFFLINE) "Host offline" else "Held") to null
            else -> LocalPresentation.activityDescription(terminal, now) to null
        }
    val command = terminal.command
    val meta =
        metaText(
            hostName,
            mono(LocalPresentation.dirTail(terminal.dir)),
            if (!command.isNullOrEmpty()) mono(command) else LocalPresentation.specLabel(terminal).takeIf { it.isNotEmpty() },
        )
    val links = LocalPresentation.workLinks(terminal)
    val footer: AnnotatedString? =
        when {
            LocalPresentation.isDead(terminal) && !terminal.errorMessage.isNullOrEmpty() -> AnnotatedString(terminal.errorMessage!!)
            links.isNotEmpty() -> mono(links.take(3).joinToString(" · ") { LocalPresentation.shortLinkLabel(it) })
            else -> null
        }
    OptioRow(
        title = terminal.title,
        modifier = modifier.testTag("terminal-row-${terminal.id}"),
        tone = LocalPresentation.rowTone(terminal),
        meta = meta,
        trailing = trailing,
        trailingTone = trailingTone,
        footer = footer,
        titleMaxLines = 1,
        onClick = onClick,
    )
}
