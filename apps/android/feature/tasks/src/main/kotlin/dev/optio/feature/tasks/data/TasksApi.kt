package dev.optio.feature.tasks.data

import dev.optio.core.network.ApiClient
import dev.optio.core.ui.log.TaskLogRow
import dev.optio.core.ui.log.TaskLogsEnvelope
import kotlinx.serialization.Serializable

// Task endpoints (iOS `Features/Run/Tasks/TasksAPI.swift`). Route-local envelopes live beside them.

@Serializable
internal data class TaskSearchResponse(
    val tasks: List<TaskRow> = emptyList(),
    val nextCursor: String? = null,
    val hasMore: Boolean? = null,
)

@Serializable internal data class TaskEventsEnvelope(val events: List<TaskEventRow> = emptyList())

@Serializable internal data class TaskActivityEnvelope(val activity: List<TaskActivityItem> = emptyList())

@Serializable internal data class SubtasksEnvelope(val subtasks: List<TaskRow> = emptyList())

@Serializable internal data class DependenciesEnvelope(val dependencies: List<TaskRow> = emptyList())

@Serializable internal data class DependentsEnvelope(val dependents: List<TaskRow> = emptyList())

@Serializable internal data class ReposEnvelope(val repos: List<RunRepoRow> = emptyList())

@Serializable internal data class PromptTemplatesEnvelope(val templates: List<RunPromptTemplateRow> = emptyList())

@Serializable internal data class PromptBody(val prompt: String? = null)

@Serializable internal data class MessageBody(val content: String, val mode: String)

@Serializable internal data class CommentBody(val content: String)

@Serializable
internal data class SubtaskBody(
    val title: String,
    val prompt: String,
    val taskType: String,
    val blocksParent: Boolean,
)

@Serializable internal data class DependsOnBody(val dependsOnIds: List<String>)

/** The newest this many stored log rows are loaded up front (the web's `HISTORICAL_LIMIT`). */
const val HISTORICAL_LOG_LIMIT = 10_000

suspend fun ApiClient.getTask(id: String): TaskDetailResponse = get<TaskDetailResponse>("/api/tasks/$id")

suspend fun ApiClient.searchTasks(query: String? = null, limit: Int = 100): List<TaskRow> =
    get<TaskSearchResponse>(
        "/api/tasks/search",
        mapOf("q" to query?.takeIf { it.isNotBlank() }, "limit" to limit),
    ).tasks

suspend fun ApiClient.cancelTask(id: String) = post("/api/tasks/$id/cancel")

/** Retry a failed / cancelled task; also "Start" for a pending one. */
suspend fun ApiClient.retryTask(id: String) = post("/api/tasks/$id/retry")

suspend fun ApiClient.forceRedoTask(id: String) = post("/api/tasks/$id/force-redo")

suspend fun ApiClient.runNowTask(id: String) = post("/api/tasks/$id/run-now")

suspend fun ApiClient.launchReview(id: String) = post("/api/tasks/$id/review")

suspend fun ApiClient.resumeTask(id: String, prompt: String?) = post("/api/tasks/$id/resume", PromptBody(prompt))

/** "Attempt resume": a fresh session on the existing PR branch. */
suspend fun ApiClient.forceRestartTask(id: String, prompt: String? = null) = post("/api/tasks/$id/force-restart", PromptBody(prompt))

/** Message a running agent (`soft` / `interrupt`) or resume a stopped one with the message. */
suspend fun ApiClient.sendTaskMessage(id: String, content: String, mode: String) =
    post("/api/tasks/$id/message", MessageBody(content, mode))

/** Stored log rows, oldest first, from [offset] (so a caller can fetch only what's new). */
suspend fun ApiClient.taskLogs(id: String, offset: Int = 0, limit: Int = HISTORICAL_LOG_LIMIT): List<TaskLogRow> =
    get<TaskLogsEnvelope>(
        "/api/tasks/$id/logs",
        mapOf("limit" to limit, "offset" to offset.takeIf { it > 0 }),
    ).logs

suspend fun ApiClient.taskEvents(id: String): List<TaskEventRow> = get<TaskEventsEnvelope>("/api/tasks/$id/events").events

suspend fun ApiClient.taskActivity(id: String): List<TaskActivityItem> = get<TaskActivityEnvelope>("/api/tasks/$id/activity").activity

suspend fun ApiClient.addTaskComment(id: String, content: String) = post("/api/tasks/$id/comments", CommentBody(content))

suspend fun ApiClient.deleteTaskComment(id: String, commentId: String) = delete("/api/tasks/$id/comments/$commentId")

suspend fun ApiClient.subtasks(id: String): List<TaskRow> = get<SubtasksEnvelope>("/api/tasks/$id/subtasks").subtasks

suspend fun ApiClient.createSubtask(id: String, title: String, prompt: String, taskType: String, blocksParent: Boolean) =
    post("/api/tasks/$id/subtasks", SubtaskBody(title, prompt, taskType, blocksParent))

suspend fun ApiClient.taskDependencies(id: String): List<TaskRow> = get<DependenciesEnvelope>("/api/tasks/$id/dependencies").dependencies

suspend fun ApiClient.taskDependents(id: String): List<TaskRow> = get<DependentsEnvelope>("/api/tasks/$id/dependents").dependents

suspend fun ApiClient.addTaskDependencies(id: String, dependsOnIds: List<String>) =
    post("/api/tasks/$id/dependencies", DependsOnBody(dependsOnIds))

suspend fun ApiClient.removeTaskDependency(id: String, dependsOnId: String) = delete("/api/tasks/$id/dependencies/$dependsOnId")

// Supporting catalogs

suspend fun ApiClient.runListRepos(): List<RunRepoRow> = get<ReposEnvelope>("/api/repos").repos

suspend fun ApiClient.runListPromptTemplates(kind: String): List<RunPromptTemplateRow> =
    get<PromptTemplatesEnvelope>("/api/prompt-templates", mapOf("kind" to kind)).templates
