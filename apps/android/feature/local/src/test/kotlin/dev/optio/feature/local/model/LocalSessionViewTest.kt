package dev.optio.feature.local.model

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.testing.Samples
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Port of iOS `LocalSessionViewTests` (itself the web's `session-view.test.ts`), with the phone's
 * rule: the transcript is the default whenever there is one, live or not.
 */
class LocalSessionViewTest {
    private val r = LocalSessionViewRule

    @Test
    fun honorsExplicitChoice() {
        assertEquals(LocalSessionView.SCREEN, r.resolve(LocalSessionView.SCREEN, hasTranscript = true, loaded = true))
        assertEquals(LocalSessionView.TRANSCRIPT, r.resolve(LocalSessionView.TRANSCRIPT, hasTranscript = false, loaded = false))
    }

    @Test
    fun waitsForTranscriptFetchBeforeDeciding() {
        assertNull(r.resolve(null, hasTranscript = false, loaded = false))
    }

    @Test
    fun prefersTranscriptWhileLiveAndWhenFinished() {
        assertEquals(LocalSessionView.TRANSCRIPT, r.resolve(null, hasTranscript = true, loaded = true))
    }

    @Test
    fun fallsBackToScreenWithoutTranscript() {
        // A plain shell, or an agent that hasn't said anything yet.
        assertEquals(LocalSessionView.SCREEN, r.resolve(null, hasTranscript = false, loaded = true))
    }

    @Test
    fun facesAreLabeledChatAndTerminal() {
        assertEquals("Chat", LocalSessionView.TRANSCRIPT.label)
        assertEquals("Terminal", LocalSessionView.SCREEN.label)
    }

    @Test
    fun offersChatOnceThereIsAConversation() {
        val shell = Samples.localTerminal(state = LocalTerminalState.EXITED).copy(spec = LocalTerminalSpec.Shell)
        assertTrue(r.canShowChat(shell, hasTranscript = true))
    }

    @Test
    fun offersChatToALiveClaudeOrCodexSessionBeforeItsFirstEntry() {
        val live = Samples.localTerminal(state = LocalTerminalState.RUNNING)
        assertTrue(r.canShowChat(live.copy(spec = LocalTerminalSpec.Agent(LocalAgentKind.CLAUDE_CODE)), hasTranscript = false))
        assertTrue(r.canShowChat(live.copy(spec = LocalTerminalSpec.Agent(LocalAgentKind.CODEX)), hasTranscript = false))
        assertFalse(r.canShowChat(live.copy(spec = LocalTerminalSpec.Agent(LocalAgentKind.GEMINI)), hasTranscript = false))
        assertFalse(r.canShowChat(live.copy(spec = LocalTerminalSpec.Shell), hasTranscript = false))
        val exited = Samples.localTerminal(state = LocalTerminalState.EXITED)
        assertFalse(r.canShowChat(exited.copy(spec = LocalTerminalSpec.Agent(LocalAgentKind.CLAUDE_CODE)), hasTranscript = false))
    }
}
