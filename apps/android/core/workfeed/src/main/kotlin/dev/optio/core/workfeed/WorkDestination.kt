package dev.optio.core.workfeed

import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute

/**
 * Where a Work row leads: the per-kind detail screen (iOS `WorkDestination`, the web's `href`).
 * The Work list is the only list in front of them; the per-kind lists were retired on web and iOS
 * alike. [route] is the Navigation 3 key the owning feature registered.
 */
sealed interface WorkDestination {
    /** A Repo Task run (`tasks`). */
    data class Task(val id: String) : WorkDestination

    /** A scheduled Task blueprint (`task_configs`). */
    data class Blueprint(val id: String) : WorkDestination

    /** A Job definition (`workflows`). */
    data class Job(val id: String) : WorkDestination

    /** One run under a Job (`/jobs/:id/runs/:runId`): where a just-started Job lands. */
    data class JobRun(val jobId: String, val runId: String) : WorkDestination

    /** An Optio Local terminal (`local_terminals`). */
    data class LocalTerminal(val id: String) : WorkDestination

    /** A Local automation (`local_blueprints`). */
    data class LocalBlueprint(val id: String) : WorkDestination

    /** An interactive pod session (`interactive_sessions`). */
    data class PodSession(val id: String) : WorkDestination

    /** A persistent agent (`persistent_agents`). */
    data class Agent(val id: String) : WorkDestination

    /** The route key of the detail screen (iOS `WorkDestinationView`). */
    fun route(): NavKey = when (this) {
        is Task -> TaskDetailRoute(id)
        is Blueprint -> ScheduledDetailRoute(id)
        is Job -> JobDetailRoute(id)
        is JobRun -> JobRunRoute(jobId = jobId, runId = runId)
        is LocalTerminal -> LocalTerminalRoute(id)
        is LocalBlueprint -> LocalAutomationRoute(id)
        is PodSession -> SessionDetailRoute(id)
        is Agent -> AgentDetailRoute(id)
    }
}
