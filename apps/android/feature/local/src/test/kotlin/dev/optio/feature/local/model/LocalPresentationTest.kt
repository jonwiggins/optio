package dev.optio.feature.local.model

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.model.WorkLinkProvider
import dev.optio.core.testing.Samples
import dev.optio.core.ui.theme.Tone
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** [LocalPresentation]: iOS `LocalPresentation` + the web's `terminal-card.test.tsx` vectors. */
class LocalPresentationTest {
    private fun terminal(
        state: LocalTerminalState = LocalTerminalState.RUNNING,
        attention: LocalAttentionState = LocalAttentionState.WORKING,
        exitCode: Int? = null,
        pendingReason: LocalTerminalPendingReason? = null,
    ) = Samples.localTerminal(state = state, attentionState = attention, exitCode = exitCode).copy(pendingReason = pendingReason)

    @Test
    fun dirTailKeepsTheLastTwoSegments() {
        assertEquals("repos/optio", LocalPresentation.dirTail("/Users/jon/repos/optio"))
        assertEquals("srv", LocalPresentation.dirTail("/srv"))
        assertEquals("/", LocalPresentation.dirTail("/"))
    }

    @Test
    fun attentionLabelMapsKnownReasonsAndFallsBack() {
        assertEquals("waiting for you", LocalPresentation.attentionLabel("stop"))
        assertEquals("rang the bell", LocalPresentation.attentionLabel("bell"))
        assertEquals("finished — review the result", LocalPresentation.attentionLabel("exit"))
        assertEquals("done — review the result", LocalPresentation.attentionLabel("done"))
        assertEquals("command finished", LocalPresentation.attentionLabel("finished"))
        assertEquals("went quiet a while ago", LocalPresentation.attentionLabel("stale"))
        assertEquals("needs you", LocalPresentation.attentionLabel(null))
        assertEquals("needs you", LocalPresentation.attentionLabel("something-new"))
    }

    @Test
    fun stateLabelsNameWhyATerminalIsPending() {
        assertEquals("Held", LocalPresentation.stateLabel(terminal(LocalTerminalState.PENDING, pendingReason = LocalTerminalPendingReason.HOLD)))
        assertEquals("Host offline", LocalPresentation.stateLabel(terminal(LocalTerminalState.PENDING, pendingReason = LocalTerminalPendingReason.HOST_OFFLINE)))
        assertEquals("Pending", LocalPresentation.stateLabel(terminal(LocalTerminalState.PENDING)))
        assertEquals("Running", LocalPresentation.stateLabel(terminal()))
        assertEquals("Exited", LocalPresentation.stateLabel(terminal(LocalTerminalState.EXITED, exitCode = 0)))
    }

    @Test
    fun aLiveTerminalWaitsOnYouWhenItNeedsYouOrSitsIdle() {
        assertTrue(LocalPresentation.waitsOnYou(terminal(attention = LocalAttentionState.NEEDS_YOU)))
        assertTrue(LocalPresentation.waitsOnYou(terminal(attention = LocalAttentionState.IDLE)))
        assertFalse(LocalPresentation.waitsOnYou(terminal(attention = LocalAttentionState.WORKING)))
        // Finished runs never "wait", even when they sit in the needs-you queue.
        assertFalse(LocalPresentation.waitsOnYou(terminal(LocalTerminalState.EXITED, LocalAttentionState.NEEDS_YOU, exitCode = 0)))
        assertEquals("waiting for input", LocalPresentation.waitingLabel(terminal(attention = LocalAttentionState.IDLE)))
    }

    @Test
    fun tonesFollowTheSessionScale() {
        assertEquals(Tone.ACCENT, LocalPresentation.stateTone(terminal(attention = LocalAttentionState.NEEDS_YOU)))
        assertEquals(Tone.WORKING, LocalPresentation.stateTone(terminal()))
        assertEquals(Tone.IDLE, LocalPresentation.stateTone(terminal(LocalTerminalState.EXITED, LocalAttentionState.IDLE, exitCode = 0)))
        assertEquals(Tone.DANGER, LocalPresentation.stateTone(terminal(LocalTerminalState.EXITED, LocalAttentionState.IDLE, exitCode = 2)))
        assertEquals(Tone.DANGER, LocalPresentation.stateTone(terminal(LocalTerminalState.ERROR, LocalAttentionState.IDLE)))

        assertNull(LocalPresentation.rowTone(terminal(LocalTerminalState.EXITED, LocalAttentionState.IDLE, exitCode = 0)), "finished rows carry no dot")
        assertEquals(Tone.DANGER, LocalPresentation.rowTone(terminal(LocalTerminalState.EXITED, LocalAttentionState.IDLE, exitCode = 1)))
        assertEquals(Tone.IDLE, LocalPresentation.rowTone(terminal(LocalTerminalState.LAUNCHING)))
        assertEquals(Tone.WORKING, LocalPresentation.rowTone(terminal()))
    }

    @Test
    fun actionsFollowTheLifecycle() {
        val held = terminal(LocalTerminalState.PENDING, pendingReason = LocalTerminalPendingReason.HOLD)
        val parked = terminal(LocalTerminalState.PENDING, pendingReason = LocalTerminalPendingReason.HOST_OFFLINE)
        assertTrue(LocalPresentation.canStart(held))
        assertFalse(LocalPresentation.canStart(parked), "a parked terminal starts itself when the host is back")
        assertTrue(LocalPresentation.canKill(terminal()))
        assertTrue(LocalPresentation.canKill(terminal(LocalTerminalState.LAUNCHING)))
        assertFalse(LocalPresentation.canDelete(terminal()))
        assertTrue(LocalPresentation.canDelete(held))
        assertTrue(LocalPresentation.canDelete(terminal(LocalTerminalState.EXITED, exitCode = 0)))
    }

    @Test
    fun resumeNeedsAnExitedClaudeOrCodexRunWithASessionId() {
        val exited = terminal(LocalTerminalState.EXITED, LocalAttentionState.NEEDS_YOU, exitCode = 0)
        assertFalse(LocalPresentation.canResume(exited), "no session id reported")
        assertTrue(LocalPresentation.canResume(exited.copy(agentSessionId = "sess-1")))
        val codex = exited.copy(agentSessionId = "s", spec = LocalTerminalSpec.Agent(LocalAgentKind.CODEX))
        assertTrue(LocalPresentation.canResume(codex))
        val gemini = exited.copy(agentSessionId = "s", spec = LocalTerminalSpec.Agent(LocalAgentKind.GEMINI))
        assertFalse(LocalPresentation.canResume(gemini))
        assertFalse(LocalPresentation.canResume(exited.copy(agentSessionId = "s", spec = LocalTerminalSpec.Shell)))
        assertFalse(LocalPresentation.canResume(terminal().copy(agentSessionId = "s")), "still running")
    }

    @Test
    fun laterAppliesToWhatSitsInTheNeedsYouQueue() {
        assertTrue(LocalPresentation.canSnooze(terminal(attention = LocalAttentionState.NEEDS_YOU)))
        assertTrue(LocalPresentation.canSnooze(terminal(LocalTerminalState.EXITED, LocalAttentionState.NEEDS_YOU, exitCode = 0)))
        assertFalse(LocalPresentation.canSnooze(terminal(attention = LocalAttentionState.WORKING)))
        assertFalse(LocalPresentation.canSnooze(terminal(LocalTerminalState.EXITED, LocalAttentionState.IDLE, exitCode = 0)))
    }

    @Test
    fun snoozedUntilOnlyCountsWhileInTheFuture() {
        val t = terminal(attention = LocalAttentionState.NEEDS_YOU)
        assertNull(LocalPresentation.snoozedUntil(t, Samples.NOW))
        val later = Samples.NOW.plusSeconds(600)
        assertEquals(later, LocalPresentation.snoozedUntil(t.copy(snoozedUntil = later.toString()), Samples.NOW))
        assertNull(LocalPresentation.snoozedUntil(t.copy(snoozedUntil = Samples.agoIso(1)), Samples.NOW))
    }

    @Test
    fun theTicketIsMergedAheadOfScannedLinksOnce() {
        val pr = WorkLink("https://github.com/acme/web/pull/42", WorkLinkKind.PR, WorkLinkProvider.GITHUB, "acme/web#42")
        val t = terminal().copy(links = listOf(pr), ticketUrl = "https://github.com/acme/web/issues/7", ticketExternalId = "7", ticketSource = "github")
        val links = LocalPresentation.workLinks(t)
        assertEquals(listOf("#7", "acme/web#42"), links.map { it.label })
        assertEquals(WorkLinkKind.ISSUE, links.first().kind)
        // Already scanned: not duplicated.
        assertEquals(1, LocalPresentation.workLinks(t.copy(ticketUrl = pr.url)).size)
        val gitlab = terminal().copy(links = emptyList(), ticketUrl = "https://gitlab.com/g/p/-/issues/3", ticketSource = "gitlab")
        assertEquals(WorkLinkProvider.GITLAB, LocalPresentation.workLinks(gitlab).single().provider)
        assertEquals("ticket", LocalPresentation.workLinks(gitlab).single().label)
    }

    @Test
    fun linkBadgesCarryOnlyTheNumber() {
        fun link(label: String, kind: WorkLinkKind) = WorkLink("https://x", kind, WorkLinkProvider.GITHUB, label)
        assertEquals("PR #519", LocalPresentation.shortLinkLabel(link("owner/repo#519", WorkLinkKind.PR)))
        assertEquals("MR !45", LocalPresentation.shortLinkLabel(link("group/proj!45", WorkLinkKind.PR)))
        assertEquals("#12", LocalPresentation.shortLinkLabel(link("owner/repo#12", WorkLinkKind.ISSUE)))
        assertEquals("ENG-12", LocalPresentation.shortLinkLabel(link("ENG-12", WorkLinkKind.ISSUE)))
    }

    @Test
    fun shortDirAndRepoMatchTheWebHelpers() {
        assertEquals("~/repos/optio", LocalPresentation.shortDir("/Users/jon/repos/optio"))
        assertEquals("~/src", LocalPresentation.shortDir("/home/dev/src"))
        assertEquals("/srv/app", LocalPresentation.shortDir("/srv/app"))
        assertNull(LocalPresentation.shortDir(null))
        assertEquals("acme/web", LocalPresentation.shortRepo("https://github.com/acme/web.git"))
        assertEquals("group/sub/proj", LocalPresentation.shortRepo("https://gitlab.example.com/group/sub/proj"))
    }

    @Test
    fun specLabelsSayWhatRuns() {
        assertEquals("shell", LocalPresentation.specLabel(terminal().copy(spec = LocalTerminalSpec.Shell)))
        assertEquals("npm run build", LocalPresentation.specLabel(terminal().copy(spec = LocalTerminalSpec.Command("npm run build"))))
        assertEquals("Claude Code", LocalPresentation.specLabel(terminal()))
    }
}
