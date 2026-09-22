package dev.optio.feature.tasks

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobFormRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:tasks`'s routes. Stubs: Agent A3 builds task / job / scheduled screens. */
fun EntryProviderScope<NavKey>.tasksEntries() {
    entry<TaskDetailRoute> { key -> PlaceholderScreen(title = "Task", detail = key.toString()) }
    entry<JobDetailRoute> { key -> PlaceholderScreen(title = "Job", detail = key.toString()) }
    entry<JobRunRoute> { key -> PlaceholderScreen(title = "Job run", detail = key.toString()) }
    entry<JobFormRoute> { key -> PlaceholderScreen(title = if (key.id == null) "New job" else "Edit job", detail = key.toString()) }
    entry<ScheduledDetailRoute> { key -> PlaceholderScreen(title = "Scheduled", detail = key.toString()) }
}
