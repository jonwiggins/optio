package dev.optio.feature.overview

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.ui.theme.Tone

/**
 * The slice of iOS `LocalPresentation` (`Features/Live/Local/LocalAPI.swift`) the Overview's
 * Needs-you section uses to pick and describe the terminals waiting on you. `:feature:local` owns
 * the full version; features never share code, so this is a copy.
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
        t.state == LocalTerminalState.ERROR -> Tone.WARNING
        t.state == LocalTerminalState.EXITED -> if ((t.exitCode ?: 0.0) == 0.0) null else Tone.WARNING
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



    /** The activity timestamp a terminal sorts by (falls back to `updatedAt`). */
    fun activity(t: LocalTerminal): String = t.lastActivityAt ?: t.updatedAt
}
