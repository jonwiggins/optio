package dev.optio.feature.reviews

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.ui.theme.Tone
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** iOS `ReviewFormat`, the pipeline and the Inbox's task labels, plus the log merge rules. */
class ReviewFormatTest {
    @Test
    fun stateLabelsAndTones() {
        assertEquals("Waiting for CI", ReviewFormat.stateLabel("waiting_ci"))
        assertEquals("Reviewing…", ReviewFormat.stateLabel("reviewing"))
        assertEquals("Draft Ready", ReviewFormat.stateLabel("ready"))
        assertEquals("Submitted", ReviewFormat.stateLabel("submitted"))
        assertEquals("Some New State", ReviewFormat.stateLabel("some_new_STATE"))
        assertEquals("1 issue", counted(1, "issue"))
        assertEquals("2 issues", counted(2, "issue"))

        assertEquals(Tone.ACCENT, ReviewFormat.stateTone("ready"), "a draft waiting for you is the only accent")
        assertEquals(Tone.WORKING, ReviewFormat.stateTone("reviewing"))
        assertEquals(Tone.IDLE, ReviewFormat.stateTone("waiting_ci"))
        assertEquals(Tone.IDLE, ReviewFormat.stateTone("stale"))
        assertEquals(Tone.DANGER, ReviewFormat.stateTone("failed"))
        assertEquals(Tone.SUCCESS, ReviewFormat.stateTone("submitted"))
    }

    @Test
    fun verdicts() {
        assertEquals(listOf("Approve", "Request Changes", "Comment"), ReviewFormat.verdicts.map(ReviewFormat::verdictLabel))
        assertEquals(listOf(Tone.SUCCESS, Tone.DANGER, Tone.WORKING), ReviewFormat.verdicts.map(ReviewFormat::verdictTone))
        assertEquals(listOf("squash", "merge", "rebase"), ReviewFormat.mergeMethods.map { it.first })
    }

    @Test
    fun pipelineSteps() {
        assertEquals(listOf("Queued", "CI", "Reviewing", "Ready", "Submitted"), ReviewFormat.pipeline.map { it.second })
        assertEquals(0, ReviewFormat.pipelineStep("queued"))
        assertEquals(2, ReviewFormat.pipelineStep("reviewing"))
        assertEquals(3, ReviewFormat.pipelineStep("stale"), "stale sits on Ready")
        assertEquals(-1, ReviewFormat.pipelineStep("failed"))
        assertEquals(-1, ReviewFormat.pipelineStep("cancelled"))
        assertEquals(true, ReviewFormat.pipelineFailed("stale"))
        assertEquals(false, ReviewFormat.pipelineFailed("ready"))
    }

    @Test
    fun hintsAndNeedsYou() {
        assertEquals("Draft ready — read it and submit", ReviewFormat.needsYou("ready"))
        assertEquals("New commits since this review — consider re-reviewing", ReviewFormat.needsYou("stale"))
        assertNull(ReviewFormat.needsYou("submitted"))
        assertEquals("Queued — a worker will pick this up shortly.", ReviewFormat.workingHint("queued"))
        assertEquals("Agent is reviewing the PR. The draft appears when it's done.", ReviewFormat.workingHint("reviewing"))
    }

    @Test
    fun mergeTitleWarnsAboutCi() {
        assertEquals("Merge this PR?", mergeTitle(null))
        assertEquals("Merge this PR?", mergeTitle(PrStatus(checksStatus = "passing", prState = "open")))
        assertEquals(
            "CI is failing. Branch protection may still block the merge. Merge anyway?",
            mergeTitle(PrStatus(checksStatus = "failing", prState = "open")),
        )
    }

    @Test
    fun issueTaskLabels() {
        fun issue(state: String?, task: Boolean = true, source: String? = "github", repoId: String? = "r") = IssueRow(
            title = "t",
            source = source,
            repo = IssueRow.Repo(id = repoId),
            optioTask = if (task) IssueRow.OptioTaskRef(taskId = "t1", state = state) else null,
        )
        assertEquals("Done" to Tone.SUCCESS, ReviewFormat.issueTaskLabel(issue("completed")))
        assertEquals("PR open" to null, ReviewFormat.issueTaskLabel(issue("pr_opened")))
        assertEquals("Failed" to Tone.DANGER, ReviewFormat.issueTaskLabel(issue("failed")))
        assertEquals("Needs you" to Tone.ACCENT, ReviewFormat.issueTaskLabel(issue("needs_attention")))
        assertEquals("Waiting On Deps" to null, ReviewFormat.issueTaskLabel(issue("waiting_on_deps")))
        assertEquals("Assigned" to null, ReviewFormat.issueTaskLabel(issue(null)))
        assertNull(ReviewFormat.issueTaskLabel(issue(null, task = false)), "assignable: no trailing text")
        assertEquals("auto-sync" to null, ReviewFormat.issueTaskLabel(issue(null, task = false, source = "linear", repoId = null)))
    }

    private fun line(content: String, ts: String, type: AgentLogEntry.TypeValue = AgentLogEntry.TypeValue.TEXT) =
        AgentLogEntry(taskId = "", timestamp = ts, type = type, content = content)

    @Test
    fun mergeDropsLiveEchoesOfHistoryRowsWithinTheWindow() {
        val history = listOf(line("a", "2026-09-22T16:00:00.000Z"), line("b", "2026-09-22T16:00:01.000Z"))
        val live = listOf(
            line("b", "2026-09-22T16:00:01.040Z"), // the row's own frame, stamped 40 ms later
            line("c", "2026-09-22T16:00:02.000Z"),
        )
        assertEquals(listOf("a", "b", "c"), LogMerge.merge(history, live).map { it.content })
    }

    @Test
    fun mergeKeepsLinesThatReallyRepeat() {
        val history = listOf(line(".", "2026-09-22T16:00:00.000Z"))
        val live = listOf(line(".", "2026-09-22T16:00:00.020Z"), line(".", "2026-09-22T16:00:00.500Z"))
        assertEquals(2, LogMerge.merge(history, live).size, "one history row absorbs one live line")
        assertEquals(
            2,
            LogMerge.merge(listOf(line("x", "2026-09-22T16:00:00.000Z")), listOf(line("x", "2026-09-22T16:00:09.000Z"))).size,
            "outside the window it is a new line",
        )
        assertEquals(
            2,
            LogMerge.merge(listOf(line("x", "t")), listOf(line("x", "t", AgentLogEntry.TypeValue.THINKING))).size,
            "a different type is a different line",
        )
    }

    @Test
    fun reloadKeepsNewerLiveLinesAndDropsAnOlderRun() {
        val oldRun = listOf(line("old", "2026-09-22T16:00:00.000Z"))
        val newHistory = listOf(line("new 1", "2026-09-22T16:10:00.000Z"))
        val onScreen = oldRun + line("new 1", "2026-09-22T16:10:00.030Z") + line("new 2", "2026-09-22T16:10:05.000Z")
        assertEquals(listOf("new 1", "new 2"), LogMerge.reload(newHistory, onScreen).map { it.content })
    }
}
