package dev.optio.feature.tasks.task

import dev.optio.core.ui.theme.Tone
import dev.optio.feature.tasks.TaskSamples
import dev.optio.feature.tasks.data.StallInfoRow
import dev.optio.feature.tasks.data.TaskRow
import dev.optio.feature.tasks.job.JobDetail
import dev.optio.feature.tasks.job.JobHeaderText
import dev.optio.feature.tasks.job.RunHeaderText
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNull

/** The text of rows and headers (iOS `TaskRowView`, `TaskDetailView.header`, `JobDetailView`, `JobRunDetailView`). */
class RowAndHeaderTextTest {
    private val now = TaskSamples.NOW

    private fun task(state: String, vararg overrides: Pair<String, Any?>): TaskRow {
        var t = TaskRow(id = "t", title = "T", state = state, repoUrl = "https://github.com/acme/web", agentType = "claude-code", createdAt = now.minusSeconds(120))
        for ((k, v) in overrides) {
            t = when (k) {
                "prState" -> t.copy(prState = v as String?)
                "prChecksStatus" -> t.copy(prChecksStatus = v as String?)
                "prNumber" -> t.copy(prNumber = v as Int?)
                "prUrl" -> t.copy(prUrl = v as String?)
                "completedAt" -> t.copy(completedAt = v as Instant?)
                "errorMessage" -> t.copy(errorMessage = v as String?)
                "isStalled" -> t.copy(isStalled = v as Boolean?)
                "pendingReason" -> t.copy(pendingReason = v as String?)
                "costUsd" -> t.copy(costUsd = v as String?)
                "taskType" -> t.copy(taskType = v as String?)
                else -> error(k)
            }
        }
        return t
    }

    @Test
    fun rowTrailingByState() {
        assertEquals("Merged" to Tone.SUCCESS, TaskRowText.trailing(task("completed", "prState" to "merged"), now))
        assertEquals("Done" to null, TaskRowText.trailing(task("completed"), now))
        assertEquals("Failed 5 min. ago" to Tone.DANGER, TaskRowText.trailing(task("failed", "completedAt" to now.minusSeconds(300)), now))
        assertEquals("Cancelled" to null, TaskRowText.trailing(task("cancelled"), now))
        assertEquals("CI passing" to Tone.SUCCESS, TaskRowText.trailing(task("pr_opened", "prChecksStatus" to "passing"), now))
        assertEquals("CI failing" to Tone.DANGER, TaskRowText.trailing(task("pr_opened", "prChecksStatus" to "failing"), now))
        assertEquals("CI pending" to null, TaskRowText.trailing(task("pr_opened", "prChecksStatus" to "pending"), now))
        assertEquals("PR open" to null, TaskRowText.trailing(task("pr_opened", "prChecksStatus" to "none"), now))
        assertEquals("Needs you" to Tone.ACCENT, TaskRowText.trailing(task("needs_attention"), now))
        assertEquals("Stalled" to Tone.ACCENT, TaskRowText.trailing(task("running", "isStalled" to true), now))
        assertEquals("2 min. ago" to null, TaskRowText.trailing(task("queued"), now))
    }

    @Test
    fun rowToneMetaAndFooter() {
        assertEquals(Tone.ACCENT, TaskRowText.tone(task("running", "isStalled" to true)))
        assertEquals(Tone.WORKING, TaskRowText.tone(task("running")))
        assertEquals(
            "acme/web · #519 · Claude Code · $0.78 · review",
            TaskRowText.meta(task("pr_opened", "prNumber" to 519, "prUrl" to "https://github.com/acme/web/pull/519", "costUsd" to "0.78", "taskType" to "review"))?.text,
        )
        assertEquals("acme/web · #7 · Claude Code", TaskRowText.meta(task("pr_opened", "prUrl" to "https://github.com/acme/web/pull/7"))?.text, "the number from the URL")
        // A dependency row (id, title, state) has nothing to show.
        assertNull(TaskRowText.meta(TaskRow(id = "d", title = "Dep", state = "queued")))

        assertEquals("boom", TaskRowText.footer(task("failed", "errorMessage" to "boom")))
        assertEquals("Held for off-peak window", TaskRowText.footer(task("queued", "pendingReason" to "waiting_for_off_peak")))
        assertEquals("2 subtasks · 1 done", TaskRowText.footer(task("running"), listOf(task("completed"), task("running"))))
        assertEquals("1 subtask · 0 done", TaskRowText.footer(task("running"), listOf(task("running"))))
        assertNull(TaskRowText.footer(task("running")))
    }

    @Test
    fun taskHeaderLines() {
        val pr = TaskSamples.prOpened
        assertEquals("started 23 min. ago · fake-model · Claude Code · $0.42", TaskHeaderText.facts(pr.task, now)?.text)
        assertEquals("e2e-org/e2e-repo · main · PR #2 · CI passing · review approved", TaskHeaderText.secondary(pr.task)?.text)
        val completed = TaskSamples.completed.task
        assertEquals("13s · fake-model · Claude Code · $0.88", TaskHeaderText.facts(completed, now)?.text)
        assertEquals("e2e-org/e2e-repo · main · PR #1 · merged", TaskHeaderText.secondary(completed)?.text)
        val review = TaskSamples.task("review").task
        assertEquals(true, TaskHeaderText.facts(review, now)?.text?.endsWith("· review"))
        val local = TaskSamples.queuedLocal.task
        assertEquals("e2e-org/e2e-repo · main · repos/e2e-repo", TaskHeaderText.secondary(local)?.text)
    }

    @Test
    fun taskNeedsYouLine() {
        assertEquals(
            TaskSamples.needsAttention.task.errorMessage,
            TaskHeaderText.needsYou(TaskSamples.needsAttention),
        )
        assertEquals("Needs your attention", TaskHeaderText.needsYou(TaskSamples.needsAttention.copy(task = TaskSamples.needsAttention.task.copy(errorMessage = null))))
        assertEquals("Agent looks stuck — check the logs", TaskHeaderText.needsYou(TaskSamples.stalledRunning))
        assertEquals(
            "Reviewer requested changes",
            TaskHeaderText.needsYou(TaskSamples.prOpened.copy(task = TaskSamples.prOpened.task.copy(prReviewStatus = "changes_requested"))),
        )
        assertNull(TaskHeaderText.needsYou(TaskSamples.prOpened))
        // Stalled only counts while running.
        assertNull(TaskHeaderText.needsYou(TaskSamples.prOpened.copy(stallInfo = StallInfoRow(isStalled = true, silentForMs = 1.0))))
    }

    @Test
    fun jobAndRunHeaders() {
        val detail = TaskSamples.jobDetail
        assertEquals("running" to Tone.WORKING, JobHeaderText.state(detail))
        assertEquals("paused" to Tone.IDLE, JobHeaderText.state(detail.copy(job = detail.job.copy(enabled = false))))
        assertEquals("active" to Tone.IDLE, JobHeaderText.state(JobDetail(detail.job)))
        assertEquals("Claude Code · last run 23 min. ago · 1 active", JobHeaderText.line(detail, now)?.text)
        assertEquals("Claude Code · no runs yet", JobHeaderText.line(JobDetail(detail.job.copy(lastRunAt = null)), now)?.text)

        val run = TaskSamples.completedRun
        assertEquals("0s · fake-model · $0.05 · 0.1k / 0.0k · 552d11a5", RunHeaderText.line(run, run.id, now)?.text)
        assertEquals(true, RunHeaderText.line(run.copy(retryCount = 2), run.id, now)?.text?.contains("retry 2"))
    }
}
