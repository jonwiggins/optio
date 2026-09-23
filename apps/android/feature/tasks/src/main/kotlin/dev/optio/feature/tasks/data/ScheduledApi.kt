package dev.optio.feature.tasks.data

import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable

// Scheduled Task blueprint endpoints (iOS `Features/Run/Scheduled/ScheduledAPI.swift`).

@Serializable internal data class TaskConfigEnvelope(val taskConfig: TaskConfigRow)

@Serializable internal data class TaskConfigsEnvelope(val taskConfigs: List<TaskConfigRow> = emptyList())

@Serializable internal data class RunTaskConfigResponse(val taskId: String)

@Serializable internal data class BlueprintRunsEnvelope(val runs: List<TaskRow> = emptyList())

suspend fun ApiClient.listTaskConfigs(): List<TaskConfigRow> = get<TaskConfigsEnvelope>("/api/task-configs").taskConfigs

suspend fun ApiClient.getTaskConfig(id: String): TaskConfigRow = get<TaskConfigEnvelope>("/api/task-configs/$id").taskConfig

/** Creates a blueprint from a body map ([ScheduledDraft.body]). */
suspend fun ApiClient.createTaskConfig(body: Map<String, Any?>): TaskConfigRow =
    post<TaskConfigEnvelope>("/api/task-configs", body).taskConfig

/** Partial update from a body map (explicit nulls clear a field). */
suspend fun ApiClient.updateTaskConfig(id: String, body: Map<String, Any?>): TaskConfigRow =
    patch<TaskConfigEnvelope>("/api/task-configs/$id", body).taskConfig

suspend fun ApiClient.setTaskConfigEnabled(id: String, enabled: Boolean): TaskConfigRow =
    patch<TaskConfigEnvelope>("/api/task-configs/$id", EnabledBody(enabled)).taskConfig

suspend fun ApiClient.deleteTaskConfig(id: String) = delete("/api/task-configs/$id")

/** `POST /api/task-configs/:id/run` → 202 `{ taskId }`: spawns one task now. */
suspend fun ApiClient.runTaskConfig(id: String): String = post<RunTaskConfigResponse>("/api/task-configs/$id/run").taskId

/** The unified runs route: for a blueprint, the tasks it spawned (newest first). */
suspend fun ApiClient.taskConfigRuns(id: String): List<TaskRow> = get<BlueprintRunsEnvelope>("/api/tasks/$id/runs").runs
