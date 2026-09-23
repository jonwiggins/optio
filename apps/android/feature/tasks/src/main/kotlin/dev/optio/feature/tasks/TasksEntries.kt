package dev.optio.feature.tasks

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobFormRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.ScheduledFormRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.feature.tasks.job.JobDetailScreen
import dev.optio.feature.tasks.job.JobFormScreen
import dev.optio.feature.tasks.job.JobRunScreen
import dev.optio.feature.tasks.scheduled.ScheduledDetailScreen
import dev.optio.feature.tasks.scheduled.ScheduledFormScreen
import dev.optio.feature.tasks.task.TaskDetailScreen

/** Registers `:feature:tasks`'s routes: Repo Tasks, Jobs and their runs, scheduled blueprints. */
fun EntryProviderScope<NavKey>.tasksEntries() {
    entry<TaskDetailRoute> { key -> TaskDetailScreen(taskId = key.id) }
    entry<JobDetailRoute> { key -> JobDetailScreen(jobId = key.id) }
    entry<JobRunRoute> { key -> JobRunScreen(jobId = key.jobId, runId = key.runId) }
    entry<JobFormRoute> { key -> JobFormScreen(jobId = key.id) }
    entry<ScheduledDetailRoute> { key -> ScheduledDetailScreen(configId = key.id) }
    entry<ScheduledFormRoute> { key -> ScheduledFormScreen(configId = key.id) }
}
