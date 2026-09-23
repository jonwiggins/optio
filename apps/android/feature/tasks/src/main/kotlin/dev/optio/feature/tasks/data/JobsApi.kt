package dev.optio.feature.tasks.data

import dev.optio.core.model.arrayValue
import dev.optio.core.model.doubleValue
import dev.optio.core.model.get
import dev.optio.core.model.objectValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.log.TaskLogRow
import dev.optio.core.ui.log.TaskLogsEnvelope
import java.time.Duration
import java.time.Instant
import java.util.Locale
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Job (standalone workflow) endpoints (iOS `Features/Run/Jobs/JobsAPI.swift`). The /api/jobs
// routes enrich workflow rows with aggregate run stats (`runCount`, `lastRunAt`, `totalCostUsd`),
// so these are local.

/** A Job (`workflows` row) with its run stats. */
@Serializable
data class JobSummary(
    val id: String,
    val name: String = "",
    val description: String? = null,
    val promptTemplate: String? = null,
    /** `{{param}}` template each run is named from; null = the job's name. */
    val runTitle: String? = null,
    val paramsSchema: Map<String, JsonElement>? = null,
    val environmentSpec: Map<String, JsonElement>? = null,
    val agentRuntime: String? = null,
    val model: String? = null,
    val maxTurns: Int? = null,
    val budgetUsd: String? = null,
    val maxConcurrent: Int? = null,
    val maxRetries: Int? = null,
    val warmPoolSize: Int? = null,
    val maxPodInstances: Int? = null,
    val maxAgentsPerPod: Int? = null,
    val enabled: Boolean? = null,
    val runTarget: String? = null,
    val localDir: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
    val runCount: Int? = null,
    @Serializable(with = LenientInstantSerializer::class) val lastRunAt: Instant? = null,
    val totalCostUsd: String? = null,
) {
    val isEnabled: Boolean
        get() = enabled ?: true

    val runtime: String
        get() = agentRuntime ?: "claude-code"

    /** `{"type":"object","properties":{…},"required":[…]}` → the run sheet's fields, by name. */
    val paramFields: List<JobParamField>
        get() {
            val props = paramsSchema?.get("properties")?.objectValue ?: return emptyList()
            val required = paramsSchema["required"]?.arrayValue?.mapNotNull { it.stringValue }?.toSet().orEmpty()
            return props.keys.sorted().map { key ->
                val def = props[key]
                JobParamField(
                    name = key,
                    type = def?.get("type")?.stringValue ?: "string",
                    description = def?.get("description")?.stringValue,
                    options = def?.get("enum")?.arrayValue?.mapNotNull { it.stringValue }.orEmpty(),
                    defaultValue = def?.get("default"),
                    required = key in required,
                )
            }
        }
}

/** One input of the Run Job sheet. */
data class JobParamField(
    val name: String,
    val type: String,
    val description: String?,
    val options: List<String>,
    val defaultValue: JsonElement?,
    val required: Boolean,
) {
    /** The default as the text a field shows (strings and numbers). */
    val defaultText: String?
        get() = defaultValue?.stringValue ?: defaultValue?.doubleValue?.let { formatNumber(it) }
}

/** One run of a Job (`workflow_runs` row). */
@Serializable
data class JobRun(
    val id: String,
    val workflowId: String? = null,
    val triggerId: String? = null,
    val params: Map<String, JsonElement>? = null,
    /** The job's run name rendered with this run's params; null = no template. */
    val title: String? = null,
    val state: String = "",
    val output: Map<String, JsonElement>? = null,
    val costUsd: String? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val modelUsed: String? = null,
    val errorMessage: String? = null,
    val sessionId: String? = null,
    val podName: String? = null,
    val localTerminalId: String? = null,
    val retryCount: Int? = null,
    @Serializable(with = LenientInstantSerializer::class) val startedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val finishedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
) {
    val isActive: Boolean
        get() = state == "running" || state == "queued"

    val canRetry: Boolean
        get() = state == "failed"

    val canCancel: Boolean
        get() = isActive

    /** "3m 12s" from start to finish (or to [now] while it runs). */
    fun durationText(now: Instant = Instant.now()): String? {
        val start = startedAt ?: return null
        val end = finishedAt ?: now
        return formatDuration(Duration.between(start, end).seconds)
    }

    /** "18.2k / 1.9k" (input / output). */
    val tokensText: String?
        get() {
            val input = inputTokens ?: return null
            val output = outputTokens ?: return null
            return String.format(Locale.US, "%.1fk / %.1fk", input / 1000.0, output / 1000.0)
        }

    val costText: String?
        get() = Cost.formatIfNonZero(costUsd)

    companion object {
        /** "45s", "3m 12s", "1h 4m" (iOS `JobRun.formatDuration`). */
        fun formatDuration(seconds: Long): String {
            val s = seconds.coerceAtLeast(0)
            if (s < 60) return "${s}s"
            if (s < 3600) return "${s / 60}m ${s % 60}s"
            return "${s / 3600}h ${(s % 3600) / 60}m"
        }
    }
}

@Serializable internal data class JobListEnvelope(val workflows: List<JobSummary> = emptyList())

@Serializable internal data class JobEnvelope(val workflow: JobSummary)

@Serializable internal data class JobRunsEnvelope(val runs: List<JobRun> = emptyList())

@Serializable internal data class JobRunEnvelope(val run: JobRun)

@Serializable internal data class EnabledBody(val enabled: Boolean)

@Serializable internal data class RunJobBody(val params: Map<String, JsonElement>? = null)

suspend fun ApiClient.listJobs(): List<JobSummary> = get<JobListEnvelope>("/api/jobs").workflows

suspend fun ApiClient.getJob(id: String): JobSummary = get<JobEnvelope>("/api/jobs/$id").workflow

/** Creates a Job from a body map ([JobDraft.createBody]). */
suspend fun ApiClient.createJob(body: Map<String, Any?>): JobSummary = post<JobEnvelope>("/api/jobs", body).workflow

/** Partial update from a body map ([JobDraft.updateBody]; explicit nulls clear a field). */
suspend fun ApiClient.updateJob(id: String, body: Map<String, Any?>): JobSummary = patch<JobEnvelope>("/api/jobs/$id", body).workflow

suspend fun ApiClient.setJobEnabled(id: String, enabled: Boolean): JobSummary =
    patch<JobEnvelope>("/api/jobs/$id", EnabledBody(enabled)).workflow

suspend fun ApiClient.cloneJob(id: String): JobSummary = post<JobEnvelope>("/api/jobs/$id/clone").workflow

suspend fun ApiClient.deleteJob(id: String) = delete("/api/jobs/$id")

suspend fun ApiClient.runJob(id: String, params: Map<String, JsonElement>?): JobRun =
    post<JobRunEnvelope>("/api/jobs/$id/runs", RunJobBody(params)).run

suspend fun ApiClient.listJobRuns(id: String, limit: Int = 50): List<JobRun> =
    get<JobRunsEnvelope>("/api/jobs/$id/runs", mapOf("limit" to limit)).runs

suspend fun ApiClient.getJobRun(runId: String): JobRun = get<JobRunEnvelope>("/api/workflow-runs/$runId").run

suspend fun ApiClient.retryJobRun(runId: String): JobRun = post<JobRunEnvelope>("/api/workflow-runs/$runId/retry").run

suspend fun ApiClient.cancelJobRun(runId: String): JobRun = post<JobRunEnvelope>("/api/workflow-runs/$runId/cancel").run

suspend fun ApiClient.jobRunLogs(runId: String, limit: Int = HISTORICAL_LOG_LIMIT): List<TaskLogRow> =
    get<TaskLogsEnvelope>("/api/workflow-runs/$runId/logs", mapOf("limit" to limit)).logs

/** Job runtimes (iOS `JobFormat`). */
object JobFormat {
    val agentRuntimes: List<Pair<String, String>> = RunFormatting.agentTypes

    /** "Claude Code"; unknown ids are title-cased ("my-runtime" → "My Runtime"). */
    fun runtimeLabel(value: String): String =
        agentRuntimes.firstOrNull { it.first == value }?.second
            ?: value.replace('-', ' ').split(' ').joinToString(" ") { part -> part.replaceFirstChar { it.titlecase(Locale.US) } }
}

private fun formatNumber(value: Double): String =
    if (value == Math.floor(value) && !value.isInfinite() && kotlin.math.abs(value) < 1e15) value.toLong().toString() else value.toString()
