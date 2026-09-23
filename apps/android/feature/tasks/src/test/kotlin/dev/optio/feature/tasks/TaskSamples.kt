package dev.optio.feature.tasks

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.OptioJson
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.log.TaskLogsEnvelope
import dev.optio.core.ui.log.asEntries
import dev.optio.feature.tasks.data.BlueprintRunsEnvelope
import dev.optio.feature.tasks.data.DependenciesEnvelope
import dev.optio.feature.tasks.data.DependentsEnvelope
import dev.optio.feature.tasks.data.JobEnvelope
import dev.optio.feature.tasks.data.JobRun
import dev.optio.feature.tasks.data.JobRunEnvelope
import dev.optio.feature.tasks.data.JobRunsEnvelope
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.PromptTemplatesEnvelope
import dev.optio.feature.tasks.data.ReposEnvelope
import dev.optio.feature.tasks.data.StallInfoRow
import dev.optio.feature.tasks.data.SubtasksEnvelope
import dev.optio.feature.tasks.data.TaskActivityEnvelope
import dev.optio.feature.tasks.data.TaskConfigEnvelope
import dev.optio.feature.tasks.data.TaskDetailResponse
import dev.optio.feature.tasks.data.TaskEventRow
import dev.optio.feature.tasks.data.TaskEventsEnvelope
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.data.TriggersEnvelope
import dev.optio.feature.tasks.job.JobDetail
import dev.optio.feature.tasks.scheduled.ScheduledDetail
import dev.optio.feature.tasks.task.TaskDetail
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset

/**
 * Sample data for screenshots, from the fixtures captured on the private test API (so the screens
 * show what the real API sends) plus a few constructed variants the seed doesn't have (a stalled
 * run, a PR with CI and review status, a plan review, several trigger types).
 */
object TaskSamples {
    /** Twenty-four minutes after the seed ran: relative times read like a live session. */
    val NOW: Instant = Instant.parse("2026-09-23T01:10:00Z")
    val clock: Clock = Clock.fixed(NOW, ZoneOffset.UTC)

    fun task(name: String) = Fixtures.decode<TaskDetailResponse>("task-$name.json")

    val prOpened: TaskDetail by lazy {
        val base = task("prOpened")
        TaskDetail(
            task = base.task.copy(prChecksStatus = "passing", prReviewStatus = "approved"),
            events = Fixtures.decode<TaskEventsEnvelope>("task-prOpened-events.json").events,
            subtasks = Fixtures.decode<SubtasksEnvelope>("task-prOpened-subtasks.json").subtasks,
            activity = Fixtures.decode<TaskActivityEnvelope>("task-prOpened-activity.json").activity,
        )
    }

    val failed: TaskDetail by lazy { TaskDetail(task("failed").task) }

    val needsAttention: TaskDetail by lazy {
        TaskDetail(
            task = task("needsAttention").task,
            events = Fixtures.decode<TaskEventsEnvelope>("task-needsAttention-events.json").events,
            dependents = Fixtures.decode<DependentsEnvelope>("task-needsAttention-dependents.json").dependents,
        )
    }

    /** A plan-review pause: needs_attention after a `plan_review` event. */
    val planReview: TaskDetail by lazy {
        needsAttention.copy(
            task = needsAttention.task.copy(errorMessage = "Plan ready for review"),
            events = needsAttention.events + TaskEventRow(id = "e-plan", fromState = "running", toState = "needs_attention", trigger = "plan_review"),
        )
    }

    /** The seed's hanging run, stalled for twelve minutes. */
    val stalledRunning: TaskDetail by lazy {
        val base = task("running")
        TaskDetail(
            task = base.task.copy(modelUsed = "claude-sonnet-4-5", costUsd = "0.3120"),
            stallInfo = StallInfoRow(isStalled = true, silentForMs = 734_000.0, thresholdMs = 300_000.0, lastLogSummary = "Bash \$ ./gradlew connectedCheck"),
        )
    }

    val completed: TaskDetail by lazy {
        val base = task("completed")
        TaskDetail(task = base.task.copy(prState = "merged", resultSummary = base.task.resultSummary ?: "Paginated the activity feed with cursor-based pages of 50."))
    }

    val waitingOnDeps: TaskDetail by lazy {
        val base = task("waitingOnDeps")
        TaskDetail(
            task = base.task,
            pendingReason = base.pendingReason,
            dependencies = Fixtures.decode<DependenciesEnvelope>("task-waitingOnDeps-dependencies.json").dependencies,
        )
    }

    val queuedLocal: TaskDetail by lazy { TaskDetail(task("queuedLocal").task) }

    /** The captured log of the PR task (the fake agent's four lines). */
    val prLogs: List<AgentLogEntry> by lazy {
        Fixtures.decode<TaskLogsEnvelope>("task-prOpened-logs.json").logs.asEntries(prOpened.task.id)
    }

    /** A realistic transcript (core:testing's), for the running screens. */
    val transcript: List<AgentLogEntry> by lazy { dev.optio.core.testing.Samples.transcript() }

    // Jobs

    val job: JobSummary by lazy { Fixtures.decode<JobEnvelope>("job-main.json").workflow }
    val webhookJob: JobSummary by lazy { Fixtures.decode<JobEnvelope>("job-webhook.json").workflow }
    val runs: List<JobRun> by lazy { Fixtures.decode<JobRunsEnvelope>("job-main-runs.json").runs }
    val completedRun: JobRun by lazy { Fixtures.decode<JobRunEnvelope>("run-completed.json").run }
    val runningRun: JobRun by lazy { Fixtures.decode<JobRunEnvelope>("run-running.json").run }
    val failedRun: JobRun by lazy { Fixtures.decode<JobRunEnvelope>("run-failed.json").run }
    val runLogs: List<AgentLogEntry> by lazy {
        Fixtures.decode<TaskLogsEnvelope>("run-completed-logs.json").logs.asEntries(completedRun.id)
    }

    /** Triggers of several types: the seed's webhook plus constructed ones. */
    val triggers: List<TriggerRow> by lazy {
        val hook = Fixtures.decode<TriggersEnvelope>("job-webhook-triggers.json").triggers.single()
        val schedule = Fixtures.decode<TriggersEnvelope>("scheduled-triggers.json").triggers.single()
        val github = OptioJson.decodeFromString<TriggerRow>(
            """{"id":"tr-gh","type":"github","enabled":true,"config":{"events":["review_requested","mentioned"],"login":"ada","repos":["e2e-org/e2e-repo"]},"createdAt":"2026-09-20T10:00:00Z"}""",
        )
        val slack = OptioJson.decodeFromString<TriggerRow>(
            """{"id":"tr-sl","type":"slack","enabled":false,"config":{"channelId":"C0123ABCD","mentionOnly":true},"createdAt":"2026-09-18T10:00:00Z"}""",
        )
        listOf(schedule, hook, github, slack)
    }

    val jobDetail: JobDetail by lazy { JobDetail(job = job, runs = runs, triggers = triggers) }

    /** A job with a params schema (for the run sheet and the config tab). */
    val paramsJob: JobSummary by lazy {
        OptioJson.decodeFromString(
            """
            {
              "id": "j-params", "name": "Triage Sentry alerts", "agentRuntime": "claude-code", "model": "sonnet",
              "promptTemplate": "Triage {{ALERT}} in {{REPO}}. Depth: {{MODE}}. Open a PR: {{OPEN_PR}}.",
              "paramsSchema": {
                "type": "object",
                "properties": {
                  "ALERT": {"type": "string", "description": "The Sentry alert URL"},
                  "REPO": {"type": "string", "default": "e2e-org/e2e-repo"},
                  "MODE": {"type": "string", "enum": ["quick", "deep"], "default": "quick"},
                  "OPEN_PR": {"type": "boolean", "default": false},
                  "MAX_FILES": {"type": "integer", "default": 10}
                },
                "required": ["ALERT"]
              },
              "maxConcurrent": 2, "maxRetries": 1, "warmPoolSize": 0, "maxPodInstances": 1, "maxAgentsPerPod": 2,
              "enabled": true, "createdAt": "2026-09-10T09:00:00Z", "updatedAt": "2026-09-21T09:00:00Z", "runCount": 0
            }
            """,
        )
    }

    // Scheduled

    val scheduled: ScheduledDetail by lazy {
        ScheduledDetail(
            config = Fixtures.decode<TaskConfigEnvelope>("scheduled.json").taskConfig.copy(description = "Keeps minor versions current; opens one PR a week."),
            triggers = Fixtures.decode<TriggersEnvelope>("scheduled-triggers.json").triggers,
            runs = Fixtures.decode<BlueprintRunsEnvelope>("scheduled-runs.json").runs,
        )
    }

    val repos by lazy { Fixtures.decode<ReposEnvelope>("repos.json").repos }
    val templates by lazy { Fixtures.decode<PromptTemplatesEnvelope>("prompt-templates-task.json").templates }
}
