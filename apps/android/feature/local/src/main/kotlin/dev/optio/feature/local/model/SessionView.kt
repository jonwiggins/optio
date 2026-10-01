package dev.optio.feature.local.model

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalSpec

/**
 * Which face of a Local session is showing: the terminal ([SCREEN], labeled "Terminal") or the
 * conversation distilled from the agent's transcript ([TRANSCRIPT], labeled "Chat"). A port of iOS
 * `SessionView.swift` (itself the web's `session-view.ts`) with the phone's rule: Chat is the
 * default whenever there is a conversation, live or not. A phone is for reading and replying, not
 * for driving a 160-column TUI.
 */
enum class LocalSessionView(val label: String) {
    TRANSCRIPT("Chat"),
    SCREEN("Terminal"),
}

object LocalSessionViewRule {
    /**
     * The face to show, or null while it can't be decided yet. An explicit [choice] always wins.
     * Otherwise wait for the transcript fetch to settle (so the terminal isn't mounted only to be
     * swapped out a moment later), then show the conversation when there is one and the screen when
     * there isn't (a plain shell, or an agent that hasn't said anything yet).
     */
    fun resolve(
        choice: LocalSessionView?,
        hasTranscript: Boolean,
        loaded: Boolean,
    ): LocalSessionView? {
        if (choice != null) return choice
        if (!loaded) return null
        return if (hasTranscript) LocalSessionView.TRANSCRIPT else LocalSessionView.SCREEN
    }

    /**
     * Whether the Chat ⇄ Terminal toggle is offered (`canShowChat` in the web's `session-view.ts`):
     * once there is a conversation, or for a live agent session whose agent writes one (Claude Code,
     * Codex) before its first entry lands. Chat then shows its empty state and its composer.
     */
    fun canShowChat(
        terminal: LocalTerminal,
        hasTranscript: Boolean,
    ): Boolean {
        if (hasTranscript) return true
        if (LocalPresentation.isDead(terminal)) return false
        val agent = (terminal.spec as? LocalTerminalSpec.Agent)?.agent ?: return false
        return agent == LocalAgentKind.CLAUDE_CODE || agent == LocalAgentKind.CODEX
    }
}
