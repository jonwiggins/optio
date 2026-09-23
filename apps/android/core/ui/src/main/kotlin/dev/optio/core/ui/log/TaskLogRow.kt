package dev.optio.core.ui.log

import dev.optio.core.model.AgentLogEntry
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

/**
 * One row of the API's stored agent logs (`GET /api/tasks/:id/logs`, job-run and review logs;
 * `schemas/task.ts` `LogEntrySchema`, iOS `TaskLogRow`): the type rides in `logType`, not `type`,
 * so it isn't an [AgentLogEntry] on the wire. [asEntry] converts it for [AgentLogView].
 */
@Serializable
data class TaskLogRow(
    val id: String? = null,
    val stream: String? = null,
    val content: String = "",
    val logType: String? = null,
    val metadata: Map<String, JsonElement>? = null,
    val timestamp: String? = null,
) {
    /** The row as an [AgentLogEntry] (unknown or missing `logType` → text). */
    fun asEntry(taskId: String): AgentLogEntry = AgentLogEntry(
        taskId = taskId,
        timestamp = timestamp.orEmpty(),
        type = AgentLogEntry.TypeValue.fromRawOrNull(logType ?: "text") ?: AgentLogEntry.TypeValue.TEXT,
        content = content,
        metadata = metadata,
    )
}

/** `{ logs: [...] }`, the envelope of the stored-log routes. */
@Serializable
data class TaskLogsEnvelope(val logs: List<TaskLogRow> = emptyList())

/** Every row as an [AgentLogEntry]. */
fun List<TaskLogRow>.asEntries(taskId: String): List<AgentLogEntry> = map { it.asEntry(taskId) }
