package dev.optio.feature.overview

import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive

// The dashboard's endpoints and their route-local shapes (iOS `Features/Overview/OverviewAPI.swift`,
// web `hooks/use-dashboard-data.ts`). Rows stay loose: routes enrich them, and a missing field must
// never blank the Overview.

/** A number the server may send as a JSON number or a numeric string (`cpu: "10"`, `cpuPercent: 23`). */
internal val JsonElement?.looseDouble: Double?
    get() = (this as? JsonPrimitive)?.takeUnless { it is JsonNull }?.content?.toDoubleOrNull()

/** `GET /api/tasks/stats` → `stats` (web `components/dashboard/types.ts`). Missing counts are 0. */
@Serializable
internal data class DashTaskStats(
    val total: Int = 0,
    val queued: Int = 0,
    val running: Int = 0,
    val ci: Int = 0,
    val review: Int = 0,
    val needsAttention: Int = 0,
    val failed: Int = 0,
    val completed: Int = 0,
)

/** One node of `GET /api/cluster/overview` (only what the summary card shows). */
@Serializable
internal data class ClusterNode(
    val name: String = "",
    val status: String? = null,
    val cpu: JsonElement? = null,
    val memory: String? = null,
    val cpuPercent: JsonElement? = null,
    val memoryUsedGi: JsonElement? = null,
    val memoryTotalGi: JsonElement? = null,
) {
    val isReady: Boolean
        get() = status == "Ready"

    /** Cores (`"10"` or `10`). */
    val cpuCores: Double?
        get() = cpu.looseDouble

    val cpuUsedPercent: Double?
        get() = cpuPercent.looseDouble

    val memoryUsed: Double?
        get() = memoryUsedGi.looseDouble

    val memoryTotal: Double?
        get() = memoryTotalGi.looseDouble

    /** Used / total memory as a rounded percentage; null without metrics. */
    val memoryPercent: Int?
        get() {
            val used = memoryUsed ?: return null
            val total = memoryTotal?.takeIf { it > 0 } ?: return null
            return Math.round(used / total * 100).toInt()
        }
}

@Serializable
internal data class ClusterSummary(
    val totalPods: Int = 0,
    val runningPods: Int = 0,
    val agentPods: Int = 0,
    val infraPods: Int = 0,
    val totalNodes: Int = 0,
    val readyNodes: Int = 0,
)

/** `GET /api/cluster/overview`, the parts the Overview reads (Insights › Cluster reads the rest). */
@Serializable
internal data class ClusterOverview(
    val nodes: List<ClusterNode> = emptyList(),
    val metricsAvailable: Boolean? = null,
    val summary: ClusterSummary = ClusterSummary(),
)

/** A task row as `GET /api/tasks` returns it (routes enrich rows, so this stays loose). */
@Serializable
internal data class DashRecentTask(
    val id: String,
    val title: String? = null,
    val state: String? = null,
    val repoUrl: String? = null,
    val repoBranch: String? = null,
    val agentType: String? = null,
    val prUrl: String? = null,
    val costUsd: String? = null,
    val errorMessage: String? = null,
    val resultSummary: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val cost: Double
        get() = costUsd?.toDoubleOrNull() ?: 0.0
}

@Serializable
private data class StatsEnvelope(val stats: DashTaskStats)

@Serializable
private data class TasksEnvelope(val tasks: List<DashRecentTask>)

@Serializable
private data class RepoRow(val id: String? = null)

@Serializable
private data class ReposEnvelope(val repos: List<RepoRow>)

@Serializable
private data class HostsEnvelope(val hosts: List<LocalHost>)

@Serializable
private data class TerminalsEnvelope(val terminals: List<LocalTerminal>)

/** Every task's state bucket (`GET /api/tasks/stats`). */
internal suspend fun ApiClient.dashTaskStats(): DashTaskStats = get<StatsEnvelope>("/api/tasks/stats").stats

/** The newest tasks (`GET /api/tasks?limit=`). */
internal suspend fun ApiClient.recentTasks(limit: Int = 5): List<DashRecentTask> = get<TasksEnvelope>("/api/tasks", mapOf("limit" to limit)).tasks

/** Tasks waiting on a human (`GET /api/tasks?state=needs_attention&limit=6`, the web's `attentionTasks`). */
internal suspend fun ApiClient.attentionTasks(limit: Int = 6): List<DashRecentTask> =
    get<TasksEnvelope>("/api/tasks", mapOf("state" to "needs_attention", "limit" to limit)).tasks

/** How many repos are connected (`GET /api/repos`). */
internal suspend fun ApiClient.repoCount(): Int = get<ReposEnvelope>("/api/repos").repos.size

/** Nodes, pods and metrics (`GET /api/cluster/overview`); admins only (403 otherwise). */
internal suspend fun ApiClient.clusterOverview(): ClusterOverview = get("/api/cluster/overview")

/** Paired machines (`GET /api/local/hosts`). */
internal suspend fun ApiClient.overviewLocalHosts(): List<LocalHost> = get<HostsEnvelope>("/api/local/hosts").hosts

/** Every Optio Local terminal (`GET /api/local/terminals`). */
internal suspend fun ApiClient.overviewLocalTerminals(): List<LocalTerminal> = get<TerminalsEnvelope>("/api/local/terminals").terminals
