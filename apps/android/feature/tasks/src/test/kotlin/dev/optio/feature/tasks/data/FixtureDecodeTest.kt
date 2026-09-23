package dev.optio.feature.tasks.data

import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.log.TaskLogsEnvelope
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

/**
 * Every response this module reads, captured from the private test API (DevLab seed, auth off):
 * the JSON files under `src/test/resources/fixtures`. Decoding goes through `OptioJson`, like the app.
 */
class FixtureDecodeTest {
    private fun task(name: String) = Fixtures.decode<TaskDetailResponse>("task-$name.json")

    @Test
    fun taskInEveryState() {
        val states = mapOf(
            "prOpened" to "pr_opened",
            "failed" to "failed",
            "needsAttention" to "needs_attention",
            "completed" to "completed",
            "running" to "running",
            "cancelled" to "cancelled",
            "waitingOnDeps" to "waiting_on_deps",
            "review" to "completed",
            "queuedLocal" to "queued",
        )
        for ((name, state) in states) {
            val detail = task(name)
            assertEquals(state, detail.task.state, name)
            assertTrue(detail.task.title.isNotEmpty(), name)
            assertNotNull(detail.task.createdAt, name)
        }
        val pr = task("prOpened").task
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/2", pr.prUrl)
        assertEquals(2, pr.prNumber)
        assertEquals("PR #2", pr.prLabel)
        assertEquals("#2", pr.prNumberLabel)
        assertEquals("e2e-org/e2e-repo", pr.repoShortName)
        assertEquals("$0.42", pr.costText)
        assertNotNull(pr.sessionId)
        assertEquals("cluster", pr.runTarget)

        val attention = task("needsAttention").task
        assertTrue(attention.errorMessage!!.startsWith("Agent completed successfully but did not open a pull request"))

        val review = task("review").task
        assertEquals("review", review.taskType)
        assertNotNull(review.parentTaskId)

        val local = task("queuedLocal").task
        assertTrue(local.isLocal)
    }

    @Test
    fun runningTaskCarriesStallInfo() {
        val running = task("running")
        assertEquals("running", running.task.state)
        val stall = assertNotNull(running.stallInfo)
        assertFalse(stall.isStalled, "the seed's hanging task never stalls (one-year threshold)")
    }

    @Test
    fun waitingTaskCarriesPendingReason() {
        val waiting = task("waitingOnDeps")
        assertNotNull(waiting.pendingReason)
    }

    @Test
    fun eventsActivitySubtasksAndDependencies() {
        val events = Fixtures.decode<TaskEventsEnvelope>("task-prOpened-events.json").events
        assertEquals("pr_opened", events.last().toState)
        assertEquals("pr_detected", events.last().trigger)

        val activity = Fixtures.decode<TaskActivityEnvelope>("task-prOpened-activity.json").activity
        assertTrue(activity.any { it.type == "event" })
        val comment = activity.single { it.isComment }
        assertEquals("Looks good on a Pixel 9. Can we also cover the high-contrast theme?", comment.content)
        assertNull(comment.user, "auth off: comments have no author")

        val subtasks = Fixtures.decode<SubtasksEnvelope>("task-prOpened-subtasks.json").subtasks
        assertEquals("review", subtasks.single().taskType)

        val dependents = Fixtures.decode<DependentsEnvelope>("task-needsAttention-dependents.json").dependents
        assertEquals("waiting_on_deps", dependents.single().state)
        val dependencies = Fixtures.decode<DependenciesEnvelope>("task-waitingOnDeps-dependencies.json").dependencies
        assertEquals("needs_attention", dependencies.single().state)
        assertNull(dependencies.single().repoUrl, "dependency rows are a projection: id, title, state")
        assertTrue(Fixtures.decode<DependenciesEnvelope>("task-prOpened-dependencies.json").dependencies.isEmpty())
    }

    @Test
    fun taskLogsAreTyped() {
        val logs = Fixtures.decode<TaskLogsEnvelope>("task-prOpened-logs.json").logs
        assertEquals(listOf("system", "text", "text", "info"), logs.map { it.logType })
        assertTrue(logs.all { it.id != null })
        assertEquals("Session started · fake-model · 0 tools", logs.first().content)
    }

    @Test
    fun searchResults() {
        val results = Fixtures.decode<TaskSearchResponse>("tasks-search.json").tasks
        assertTrue(results.size >= 9)
        assertTrue(results.all { it.id.isNotEmpty() && it.state.isNotEmpty() })
    }

    @Test
    fun jobWithRunsAndThePostgresLastRunAt() {
        val job = Fixtures.decode<JobEnvelope>("job-main.json").workflow
        assertEquals("Nightly release notes", job.name)
        assertEquals(3, job.runCount)
        assertEquals("$0.06", dev.optio.core.ui.format.Cost.format(job.totalCostUsd))
        // `lastRunAt` comes back as Postgres text ("2026-09-23 00:46:26.671658+00"), not ISO.
        assertEquals(Instant.parse("2026-09-23T00:46:26.671658Z"), job.lastRunAt)
        assertTrue(job.isEnabled)
        assertEquals("claude-code", job.runtime)
        assertTrue(job.paramFields.isEmpty(), "no paramsSchema")

        val runs = Fixtures.decode<JobRunsEnvelope>("job-main-runs.json").runs
        assertEquals(setOf("completed", "failed", "running"), runs.map { it.state }.toSet())
        val running = runs.single { it.state == "running" }
        assertTrue(running.isActive && running.canCancel && !running.canRetry)
        val failed = runs.single { it.state == "failed" }
        assertTrue(failed.canRetry && !failed.canCancel)
    }

    @Test
    fun runDetailAndLogs() {
        val run = Fixtures.decode<JobRunEnvelope>("run-completed.json").run
        assertEquals("completed", run.state)
        assertEquals("$0.05", run.costText)
        assertEquals("0.1k / 0.0k", run.tokensText)
        assertEquals("[[mock:cost:0.0520]]", run.params?.get("mode")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
        assertNotNull(run.output)
        assertEquals("0s", run.durationText())

        val logs = Fixtures.decode<TaskLogsEnvelope>("run-completed-logs.json").logs
        assertEquals(3, logs.size)
        assertEquals("system", logs.first().logType)

        val failed = Fixtures.decode<JobRunEnvelope>("run-failed.json").run
        assertEquals("failed", failed.state)
        assertNotNull(failed.errorMessage)
    }

    @Test
    fun webhookJobTriggers() {
        val triggers = Fixtures.decode<TriggersEnvelope>("job-webhook-triggers.json").triggers
        val hook = triggers.single()
        assertEquals(TriggerKind.WEBHOOK, hook.kind)
        assertEquals("android-e2e-sentry-4964", hook.webhookPath)
        assertEquals("http://10.0.2.2:4964/api/hooks/android-e2e-sentry-4964", hook.webhookUrl("http://10.0.2.2:4964/"))
        assertNotNull(hook.lastFiredAt)
        assertTrue(Fixtures.decode<TriggersEnvelope>("job-main-triggers.json").triggers.isEmpty())
    }

    @Test
    fun scheduledBlueprintTriggersAndRuns() {
        val config = Fixtures.decode<TaskConfigEnvelope>("scheduled.json").taskConfig
        assertEquals("Weekly dependency bump", config.name)
        assertEquals("main", config.repoBranch)
        assertEquals(100, config.priority)
        assertTrue(config.enabled)

        val trigger = Fixtures.decode<TriggersEnvelope>("scheduled-triggers.json").triggers.single()
        assertEquals("0 9 * * 1", trigger.cronExpression)
        assertEquals("Every Monday 09:00", ScheduleFormat.humanize(trigger))
        assertEquals(Instant.parse("2026-09-28T15:00:00Z"), trigger.nextFireAt)

        val runs = Fixtures.decode<BlueprintRunsEnvelope>("scheduled-runs.json").runs
        assertEquals("pr_opened", runs.single().state)
    }

    @Test
    fun reposAndPromptTemplates() {
        val repos = Fixtures.decode<ReposEnvelope>("repos.json").repos
        assertEquals(setOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), repos.map { it.displayName }.toSet())
        val templates = Fixtures.decode<PromptTemplatesEnvelope>("prompt-templates-task.json").templates
        assertEquals("Add a feature flag", templates.single().name)
        assertEquals("task", templates.single().kind)
    }
}
