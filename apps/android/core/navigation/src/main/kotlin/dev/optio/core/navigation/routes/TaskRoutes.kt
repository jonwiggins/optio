package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:tasks` (Agent A3). iOS: Features/Run/{Tasks,Jobs,Scheduled}/*.

/** A Repo Task run (`tasks` row). */
@Serializable
data class TaskDetailRoute(val id: String) : NavKey

/** A Job (standalone workflow definition). */
@Serializable
data class JobDetailRoute(val id: String) : NavKey

/** One run of a Job. */
@Serializable
data class JobRunRoute(val jobId: String, val runId: String) : NavKey

/** Create ([id] null) or edit a Job. */
@Serializable
data class JobFormRoute(val id: String? = null) : NavKey

/** A scheduled Task blueprint (`task_configs` row). */
@Serializable
data class ScheduledDetailRoute(val id: String) : NavKey
