package dev.optio.feature.local.model

/**
 * Which face of a Local session is showing: the terminal ([SCREEN]) or the conversation distilled
 * from the agent's transcript ([TRANSCRIPT]). A port of iOS `SessionView.swift` (itself the web's
 * `session-view.ts`) with the phone's rule: the transcript is the default whenever there is one,
 * live or not. A phone is for reading and replying, not for driving a 160-column TUI.
 */
enum class LocalSessionView(val label: String) {
    TRANSCRIPT("Transcript"),
    SCREEN("Screen"),
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
}
