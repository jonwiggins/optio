package dev.optio.feature.overview

import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.tabularNums

/**
 * The slice of iOS `LocalPresentation` (`Features/Live/Local/LocalAPI.swift`, itself web
 * `terminal-card.tsx` / `work-links.tsx`) the Overview's Needs-you section uses. `:feature:local`
 * owns the full version; features never share code, so this is a copy.
 */
internal object LocalPresentation {
    fun isDead(t: LocalTerminal): Boolean = t.state == LocalTerminalState.EXITED || t.state == LocalTerminalState.ERROR

    /**
     * A live terminal that is waiting on the human: the daemon's `needs_you`, or a running terminal
     * that has gone `idle` (an agent at its prompt in a plain shell, which the daemon cannot tell
     * from a quiet command).
     */
    fun waitsOnYou(t: LocalTerminal): Boolean {
        if (isDead(t)) return false
        if (t.attentionState == LocalAttentionState.NEEDS_YOU) return true
        return t.state == LocalTerminalState.RUNNING && t.attentionState == LocalAttentionState.IDLE
    }

    fun attentionLabel(reason: String?): String = when (reason) {
        "stop" -> "waiting for you"
        "notification" -> "wants your attention"
        "bell" -> "rang the bell"
        "quiet" -> "gone quiet — probably waiting on you"
        "exit" -> "finished — review the result"
        else -> "needs you"
    }

    /** Trailing label for a terminal that waits on you. */
    fun waitingLabel(t: LocalTerminal): String =
        if (t.attentionState == LocalAttentionState.NEEDS_YOU) attentionLabel(t.attentionReason) else "waiting for input"

    /** Row dot: yellow while it waits on you, red on error, purple while working, none once finished. */
    fun rowTone(t: LocalTerminal): Tone? = when {
        waitsOnYou(t) -> Tone.ACCENT
        t.state == LocalTerminalState.ERROR -> Tone.DANGER
        t.state == LocalTerminalState.EXITED -> if ((t.exitCode ?: 0.0) == 0.0) null else Tone.DANGER
        t.state == LocalTerminalState.PENDING || t.state == LocalTerminalState.LAUNCHING -> Tone.IDLE
        t.attentionState == LocalAttentionState.WORKING -> Tone.WORKING
        else -> Tone.IDLE
    }

    /** Last two path segments of an absolute dir — enough to recognise a checkout. */
    fun dirTail(dir: String): String {
        val tail = dir.split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
        return tail.ifEmpty { dir }
    }

    fun agentLabel(agent: LocalAgentKind): String = when (agent) {
        LocalAgentKind.CLAUDE_CODE -> "Claude Code"
        LocalAgentKind.CODEX -> "Codex"
        LocalAgentKind.CURSOR -> "Cursor"
        LocalAgentKind.GEMINI -> "Gemini"
        LocalAgentKind.OPENCODE -> "OpenCode"
        LocalAgentKind.UNKNOWN -> agent.raw
    }

    fun specLabel(spec: LocalTerminalSpec): String = when (spec) {
        LocalTerminalSpec.Shell -> "shell"
        is LocalTerminalSpec.Command -> spec.command
        is LocalTerminalSpec.Agent -> agentLabel(spec.agent)
        is LocalTerminalSpec.Unknown -> ""
    }

    /** The ticket link merged in ahead of the scanned links (`collectWorkLinks`). */
    fun workLinks(t: LocalTerminal): List<WorkLink> {
        val ticketUrl = t.ticketUrl ?: return t.links
        if (t.links.any { it.url == ticketUrl }) return t.links
        val provider = if (t.ticketSource == "gitlab") WorkLinkProvider.GITLAB else WorkLinkProvider.GITHUB
        val label = t.ticketExternalId?.let { "#$it" } ?: "ticket"
        return listOf(WorkLink(url = ticketUrl, kind = WorkLinkKind.ISSUE, provider = provider, label = label)) + t.links
    }

    /** `owner/repo#519` → `PR #519`; `group/proj!45` → `MR !45`; ticket refs (`ENG-12`) as they are. */
    fun shortLabel(link: WorkLink): String {
        val label = link.label
        val i = label.indexOfLast { it == '#' || it == '!' }
        if (i < 0) return label
        val number = label.substring(i)
        return if (link.kind == WorkLinkKind.PR) (if (number.startsWith("!")) "MR " else "PR ") + number else number
    }

    /** The activity timestamp a terminal sorts by (falls back to `updatedAt`). */
    fun activity(t: LocalTerminal): String = t.lastActivityAt ?: t.updatedAt
}

/**
 * One terminal waiting on you (iOS `TerminalRowView` in the Needs-you section): the dot, the
 * title, `host · dir · command`, the waiting reason, and the error or links underneath.
 */
@Composable
internal fun TerminalRow(
    terminal: LocalTerminal,
    hostName: String?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val needsYou = LocalPresentation.waitsOnYou(terminal)
    val (trailing, tone) = when {
        needsYou -> LocalPresentation.waitingLabel(terminal) to Tone.ACCENT
        terminal.state == LocalTerminalState.ERROR -> "Error" to Tone.DANGER
        terminal.state == LocalTerminalState.EXITED && (terminal.exitCode ?: 0.0) != 0.0 -> "exit ${terminal.exitCode?.toInt()}" to Tone.DANGER
        terminal.state == LocalTerminalState.EXITED -> "Finished" to null
        terminal.state == LocalTerminalState.PENDING ->
            (if (terminal.pendingReason == LocalTerminalPendingReason.HOST_OFFLINE) "Host offline" else "Held") to null
        else -> null to null
    }
    val command = terminal.command?.takeIf { it.isNotEmpty() }
    val meta = metaText(
        hostName,
        mono(LocalPresentation.dirTail(terminal.dir)),
        command?.let(::mono) ?: LocalPresentation.specLabel(terminal.spec),
    )
    val footer: AnnotatedString? = when {
        LocalPresentation.isDead(terminal) && !terminal.errorMessage.isNullOrEmpty() -> AnnotatedString(terminal.errorMessage.orEmpty())
        else -> LocalPresentation.workLinks(terminal).takeIf { it.isNotEmpty() }?.let { links ->
            buildAnnotatedString {
                withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) {
                    append(links.take(3).joinToString(" · ") { LocalPresentation.shortLabel(it) })
                }
            }
        }
    }
    OptioRow(
        title = terminal.title,
        tone = LocalPresentation.rowTone(terminal),
        meta = meta,
        footer = footer,
        titleMaxLines = 1,
        trailingContent = trailing?.let { text -> { TrailingLabel(text, tone) } },
        onClick = onClick,
        modifier = modifier,
    )
}

/**
 * [OptioRow]'s trailing text, but capped in width so a long reason ("gone quiet — probably
 * waiting on you", an error message) truncates instead of squeezing the title.
 */
@Composable
internal fun RowScope.TrailingLabel(
    text: String,
    tone: Tone?,
) {
    Text(
        text,
        style = OptioTheme.type.footnote.tabularNums(),
        color = tone?.textColor ?: OptioTheme.colors.tertiaryLabel,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier.widthIn(max = 150.dp).padding(start = Spacing.xs, top = 3.dp),
    )
}
