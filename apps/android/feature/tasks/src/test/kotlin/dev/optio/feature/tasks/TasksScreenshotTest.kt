package dev.optio.feature.tasks

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.tasks.common.FormSection
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.job.JobDetailActions
import dev.optio.feature.tasks.job.JobDetailContent
import dev.optio.feature.tasks.job.JobDraft
import dev.optio.feature.tasks.job.JobFormContent
import dev.optio.feature.tasks.job.JobRunContent
import dev.optio.feature.tasks.job.JobSection
import dev.optio.feature.tasks.job.RunJobForm
import dev.optio.feature.tasks.job.RunSection
import dev.optio.feature.tasks.scheduled.ScheduledDetailActions
import dev.optio.feature.tasks.scheduled.ScheduledDetailContent
import dev.optio.feature.tasks.scheduled.ScheduledDraft
import dev.optio.feature.tasks.scheduled.ScheduledFormContent
import dev.optio.feature.tasks.scheduled.ScheduledSection
import dev.optio.feature.tasks.task.TaskDetail
import dev.optio.feature.tasks.task.TaskDetailActions
import dev.optio.feature.tasks.task.TaskDetailContent
import dev.optio.feature.tasks.task.TaskSection
import dev.optio.feature.tasks.trigger.TriggerEditor
import java.io.IOException
import org.junit.Test

/**
 * Every screen of `:feature:tasks`, light and dark: `./gradlew :feature:tasks:recordRoborazziDebug`,
 * then look in `feature/tasks/build/outputs/roborazzi/`.
 */
class TasksScreenshotTest : ScreenshotTest() {
    private val clock = TaskSamples.clock
    private val baseUrl = "http://10.0.2.2:4964"

    private fun taskScreen(
        name: String,
        detail: TaskDetail,
        section: TaskSection = TaskSection.LOGS,
        logs: List<dev.optio.core.model.AgentLogEntry> = emptyList(),
        size: ScreenSize = ScreenSize.PHONE,
        wholeScreen: Boolean = false,
        interact: dev.optio.core.testing.ScreenScope.() -> Unit = {},
        viewer: Boolean = false,
        followed: Boolean = false,
    ) = captureScreens(name, size = size, clock = clock, wholeScreen = wholeScreen, interact = interact) {
        CompositionLocalProvider(LocalCurrentUser provides if (viewer) Samples.currentUser(role = "viewer") else null) {
            TaskDetailContent(
                state = LoadState.Loaded(detail),
                logEntries = logs,
                logConnected = true,
                logLoaded = true,
                busy = false,
                actions = TaskDetailActions(),
                initialSection = section,
                followed = followed,
                onToggleFollow = {},
            )
        }
    }

    // region Task detail

    @Test
    fun taskPrOpenedLogs() = taskScreen("Task_PrOpened_Logs", TaskSamples.prOpened, logs = TaskSamples.prLogs)

    @Test
    fun taskStalledRunning() = taskScreen("Task_Running_Stalled", TaskSamples.stalledRunning, logs = TaskSamples.transcript, followed = true)

    @Test
    fun taskRunningMenu() = taskScreen(
        "Task_Running_Menu",
        TaskSamples.stalledRunning,
        logs = TaskSamples.transcript,
        wholeScreen = true,
        interact = { onNodeWithTag("overflow").performClick() },
    )

    @Test
    fun taskFailedWithMenu() = taskScreen(
        "Task_Failed_Menu",
        TaskSamples.failed,
        logs = TaskSamples.prLogs.take(2),
        wholeScreen = true,
        interact = { onNodeWithTag("overflow").performClick() },
    )

    @Test
    fun taskPlanReview() = taskScreen("Task_PlanReview", TaskSamples.planReview, logs = TaskSamples.transcript.takeLast(4))

    @Test
    fun taskCompletedActivity() = taskScreen("Task_Completed_Activity", TaskSamples.completed.copy(activity = TaskSamples.prOpened.activity), section = TaskSection.ACTIVITY)

    @Test
    fun taskSubtasks() = taskScreen("Task_Subtasks", TaskSamples.prOpened, section = TaskSection.SUBTASKS)

    @Test
    fun taskWaitingOnDeps() = taskScreen("Task_WaitingOnDeps_Deps", TaskSamples.waitingOnDeps, section = TaskSection.DEPS)

    @Test
    fun taskNeedsAttentionBlocks() = taskScreen("Task_NeedsAttention_Deps", TaskSamples.needsAttention, section = TaskSection.DEPS)

    @Test
    fun taskLocalQueued() = taskScreen("Task_Local_Queued", TaskSamples.queuedLocal)

    @Test
    fun taskOnATablet() = taskScreen("Task_Tablet", TaskSamples.prOpened, logs = TaskSamples.transcript, size = ScreenSize.TABLET)

    @Test
    fun jobOnATablet() = captureScreens("Job_Tablet", size = ScreenSize.TABLET, clock = clock) {
        JobDetailContent(LoadState.Loaded(TaskSamples.jobDetail), busy = false, baseUrl = baseUrl, actions = JobDetailActions(), initialSection = JobSection.TRIGGERS)
    }

    @Test
    fun taskViewerReadOnly() = taskScreen("Task_PrOpened_Viewer", TaskSamples.prOpened, logs = TaskSamples.prLogs, viewer = true)

    @Test
    fun taskLoadingAndError() {
        captureScreens("Task_Loading", clock = clock) {
            TaskDetailContent(LoadState.Loading(), emptyList(), false, false, false, TaskDetailActions())
        }
        captureScreens("Task_Error", clock = clock) {
            TaskDetailContent(LoadState.Failed(IOException("timeout")), emptyList(), false, false, false, TaskDetailActions())
        }
    }

    // endregion

    // region Jobs

    @Test
    fun jobRuns() = captureScreens("Job_Runs", clock = clock) {
        JobDetailContent(LoadState.Loaded(TaskSamples.jobDetail), busy = false, baseUrl = baseUrl, actions = JobDetailActions())
    }

    @Test
    fun jobTriggers() = captureScreens("Job_Triggers", size = ScreenSize.TALL, clock = clock) {
        JobDetailContent(LoadState.Loaded(TaskSamples.jobDetail), busy = false, baseUrl = baseUrl, actions = JobDetailActions(), initialSection = JobSection.TRIGGERS)
    }

    @Test
    fun jobConfig() = captureScreens("Job_Config", size = ScreenSize.TALL, clock = clock, interact = { onNodeWithTag("prompt-template-toggle").performClick() }) {
        val detail = TaskSamples.jobDetail.copy(job = TaskSamples.paramsJob)
        JobDetailContent(LoadState.Loaded(detail), busy = false, baseUrl = baseUrl, actions = JobDetailActions(), initialSection = JobSection.CONFIG)
    }

    @Test
    fun jobEmpty() = captureScreens("Job_NoRuns", clock = clock) {
        JobDetailContent(LoadState.Loaded(dev.optio.feature.tasks.job.JobDetail(TaskSamples.paramsJob)), busy = false, baseUrl = baseUrl, actions = JobDetailActions())
    }

    @Test
    fun jobRunLogs() = captureScreens("JobRun_Logs", clock = clock) {
        JobRunContent(
            runId = TaskSamples.runningRun.id,
            state = LoadState.Loaded(TaskSamples.runningRun.copy(modelUsed = "claude-sonnet-4-5")),
            jobName = "Nightly release notes",
            busy = false,
            logEntries = TaskSamples.transcript,
            logConnected = true,
            logLoaded = true,
            logError = null,
        )
    }

    @Test
    fun jobRunDetails() = captureScreens("JobRun_Details", size = ScreenSize.TALL, clock = clock) {
        JobRunContent(
            runId = TaskSamples.completedRun.id,
            state = LoadState.Loaded(TaskSamples.completedRun),
            jobName = "Nightly release notes",
            busy = false,
            logEntries = TaskSamples.runLogs,
            logConnected = false,
            logLoaded = true,
            logError = null,
            initialSection = RunSection.DETAILS,
        )
    }

    @Test
    fun jobRunFailed() = captureScreens("JobRun_Failed", clock = clock) {
        JobRunContent(
            runId = TaskSamples.failedRun.id,
            state = LoadState.Loaded(TaskSamples.failedRun),
            jobName = "Nightly release notes",
            busy = false,
            logEntries = emptyList(),
            logConnected = false,
            logLoaded = true,
            logError = null,
        )
    }

    @Test
    fun jobFormEdit() = captureScreens("JobForm_Edit", size = ScreenSize.TALL, clock = clock) {
        val draft = JobDraft.of(TaskSamples.paramsJob, TaskSamples.triggers.take(2))
        JobFormContent(LoadState.Loaded(Unit), draft, saving = false, error = null, baseUrl = baseUrl, onChange = {}, onSave = {})
    }

    @Test
    fun jobFormNew() = captureScreens("JobForm_New", clock = clock) {
        JobFormContent(LoadState.Loaded(Unit), JobDraft(), saving = false, error = null, baseUrl = baseUrl, onChange = {}, onSave = {})
    }

    @Test
    fun runJobSheet() = captureScreens("RunJob_Sheet", size = ScreenSize.TALL, clock = clock) {
        Column(Modifier.statusBarsPadding()) {
            RunJobForm(job = TaskSamples.paramsJob, onRun = {}, onCancel = {})
        }
    }

    @Test
    fun runJobSheetNoParams() = captureScreens("RunJob_Sheet_NoParams", clock = clock) {
        Column(Modifier.statusBarsPadding()) {
            RunJobForm(job = TaskSamples.job, onRun = {}, onCancel = {})
        }
    }

    // endregion

    // region Triggers

    @Test
    fun triggerEditors() = captureScreens("Trigger_Editors", size = ScreenSize.TALL, clock = clock) {
        Column(Modifier.verticalScroll(rememberScrollState()).statusBarsPadding()) {
            FormSection(header = "Schedule") {
                TriggerEditor(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "0 9 * * 1-5"), onChange = {}, baseUrl = baseUrl)
            }
            FormSection(header = "GitHub") {
                TriggerEditor(TriggerDraft.new(TriggerKind.GITHUB).toggleEvent("review_requested", true), onChange = {}, baseUrl = baseUrl, showEnabled = false)
            }
            FormSection(header = "Webhook") {
                TriggerEditor(TriggerDraft.new(TriggerKind.WEBHOOK).withString("path", "nightly-notes"), onChange = {}, baseUrl = baseUrl, showEnabled = false)
            }
        }
    }

    @Test
    fun triggerEditorsSlackTicket() = captureScreens("Trigger_Editors_Slack_Ticket", size = ScreenSize.TALL, clock = clock) {
        Column(Modifier.verticalScroll(rememberScrollState()).statusBarsPadding()) {
            FormSection(header = "Slack") {
                TriggerEditor(TriggerDraft.new(TriggerKind.SLACK).withString("channelId", "C0123ABCD"), onChange = {}, baseUrl = baseUrl, showEnabled = false)
            }
            FormSection(header = "Ticket") {
                TriggerEditor(TriggerDraft.new(TriggerKind.TICKET).withStrings("labels", listOf("deps", "security")), onChange = {}, baseUrl = baseUrl, showEnabled = false)
            }
            FormSection(header = "Linear") {
                TriggerEditor(TriggerDraft.new(TriggerKind.LINEAR).toggleEvent("created", true), onChange = {}, baseUrl = baseUrl, showEnabled = false)
            }
        }
    }

    // endregion

    // region Scheduled

    @Test
    fun scheduledConfig() = captureScreens("Scheduled_Config", size = ScreenSize.TALL, clock = clock) {
        ScheduledDetailContent(LoadState.Loaded(TaskSamples.scheduled), busy = false, baseUrl = baseUrl, actions = ScheduledDetailActions())
    }

    @Test
    fun scheduledTriggers() = captureScreens("Scheduled_Triggers", clock = clock) {
        val detail = TaskSamples.scheduled.copy(triggers = TaskSamples.scheduled.triggers + TaskSamples.triggers.drop(1))
        ScheduledDetailContent(LoadState.Loaded(detail), busy = false, baseUrl = baseUrl, actions = ScheduledDetailActions(), initialSection = ScheduledSection.TRIGGERS)
    }

    @Test
    fun scheduledRuns() = captureScreens("Scheduled_Runs", clock = clock) {
        ScheduledDetailContent(LoadState.Loaded(TaskSamples.scheduled), busy = false, baseUrl = baseUrl, actions = ScheduledDetailActions(), initialSection = ScheduledSection.RUNS)
    }

    @Test
    fun scheduledForm() = captureScreens("Scheduled_Form", size = ScreenSize.TALL, clock = clock) {
        ScheduledFormContent(
            loading = LoadState.Loaded(Unit),
            draft = ScheduledDraft.of(TaskSamples.scheduled.config),
            repos = TaskSamples.repos,
            templates = TaskSamples.templates,
            saving = false,
            error = null,
            onChange = {},
            onSelectRepo = {},
            onSelectTemplate = {},
            onSave = {},
        )
    }

    // endregion
}
