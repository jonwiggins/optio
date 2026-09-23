package dev.optio.feature.insights

import dev.optio.core.model.stringValue
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.Transient
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// Route-level shapes of the Insights screens (iOS `InsightsAPI.swift`, `OverviewAPI.swift`
// cluster types). The analytics and cluster routes declare `z.unknown()` responses and compute
// their bodies in SQL / from Kubernetes, so everything is optional with a default.

// region Analytics (apps/api/src/services/analytics-service.ts)

@Serializable
data class PerformanceDurations(
    val avgWallClock: Double? = null,
    val p50WallClock: Double? = null,
    val p95WallClock: Double? = null,
    val avgExecution: Double? = null,
    val p50Execution: Double? = null,
    val p95Execution: Double? = null,
    val avgQueueWait: Double? = null,
    val taskCount: Int? = null,
)

@Serializable
data class TasksPerDayPoint(
    val date: String,
    val total: Int? = null,
    val succeeded: Int? = null,
    val failed: Int? = null,
)

@Serializable
data class PerformanceAnalytics(
    val durations: PerformanceDurations? = null,
    val successRate: Double? = null,
    val successRateTrend: Double? = null,
    val tasksPerDay: List<TasksPerDayPoint>? = null,
)

@Serializable
data class AgentModelStat(
    val model: String? = null,
    val taskCount: Int? = null,
    val avgCost: String? = null,
)

@Serializable
data class AgentAnalyticsRow(
    val agentType: String? = null,
    val taskCount: Int? = null,
    val successRate: Double? = null,
    val avgDuration: Double? = null,
    val avgCost: String? = null,
    val avgRetries: Double? = null,
    val models: List<AgentModelStat>? = null,
)

@Serializable
data class AgentAnalytics(val agents: List<AgentAnalyticsRow>? = null)

@Serializable
data class ErrorMessageCount(
    val message: String = "",
    val count: Int = 0,
)

@Serializable
data class FailureByRepo(
    val repoUrl: String = "",
    val total: Int? = null,
    val failed: Int? = null,
    val failureRate: Double? = null,
)

@Serializable
data class FailureByAgent(
    val agentType: String = "",
    val total: Int? = null,
    val failed: Int? = null,
    val failureRate: Double? = null,
)

@Serializable
data class FailureByModel(
    val model: String = "",
    val total: Int? = null,
    val failed: Int? = null,
    val failureRate: Double? = null,
)

@Serializable
data class FailureAnalytics(
    val errorMessages: List<ErrorMessageCount>? = null,
    val failureByRepo: List<FailureByRepo>? = null,
    val failureByAgent: List<FailureByAgent>? = null,
    val failureByModel: List<FailureByModel>? = null,
    val retrySuccessRate: Double? = null,
    val retriedCount: Int? = null,
    val retrySucceededCount: Int? = null,
    val stallCount: Int? = null,
    val stallRecoveryRate: Double? = null,
)

@Serializable
data class PrFunnel(
    val prOpened: Int? = null,
    val ciPassed: Int? = null,
    val reviewApproved: Int? = null,
    val merged: Int? = null,
)

@Serializable
data class PrAnalytics(
    val totalPrs: Int? = null,
    val merged: Int? = null,
    val closed: Int? = null,
    val open: Int? = null,
    val ciPassRate: Double? = null,
    val reviewApprovalRate: Double? = null,
    val autoMergeRate: Double? = null,
    val avgMergeTime: Double? = null,
    val mergeCount: Int? = null,
    val funnel: PrFunnel? = null,
)

// endregion

// region Costs (apps/api/src/routes/analytics.ts `/api/analytics/costs`)

@Serializable
data class CostSummary(
    val totalCost: String? = null,
    val taskCount: Int? = null,
    val tasksWithCost: Int? = null,
    val avgCost: String? = null,
    val costTrend: String? = null,
    val prevPeriodCost: String? = null,
    val days: Int? = null,
)

@Serializable
data class CostForecast(
    val dailyAvgCost: String? = null,
    val monthCostSoFar: String? = null,
    val forecastedMonthTotal: String? = null,
    val daysRemaining: Int? = null,
)

@Serializable
data class DailyCost(
    val date: String,
    val cost: Double? = null,
    val taskCount: Int? = null,
)

@Serializable
data class CostByRepo(
    val repoUrl: String,
    val totalCost: Double? = null,
    val taskCount: Int? = null,
)

@Serializable
data class CostByType(
    val taskType: String,
    val totalCost: Double? = null,
    val taskCount: Int? = null,
)

@Serializable
data class CostByModel(
    val model: String,
    val totalCost: Double? = null,
    val taskCount: Int? = null,
    val successRate: Double? = null,
    val avgCost: Double? = null,
    val totalInputTokens: Double? = null,
    val totalOutputTokens: Double? = null,
)

@Serializable
data class CostAnomaly(
    val id: String,
    val title: String? = null,
    val repoUrl: String? = null,
    val taskType: String? = null,
    val state: String? = null,
    val costUsd: String? = null,
    val modelUsed: String? = null,
    val repoAvgCost: Double? = null,
    val costRatio: Double? = null,
    /** Postgres text, not ISO: read with [InsightsDates.parse]. */
    val createdAt: String? = null,
)

@Serializable
data class ModelSuggestion(
    val repoUrl: String,
    val currentModel: String? = null,
    val taskCount: Int? = null,
    val avgCost: Double? = null,
    val cheaperModelAvgCost: Double? = null,
)

@Serializable
data class TopCostTask(
    val id: String,
    val title: String? = null,
    val repoUrl: String? = null,
    val taskType: String? = null,
    val state: String? = null,
    val costUsd: String? = null,
    val inputTokens: Double? = null,
    val outputTokens: Double? = null,
    val modelUsed: String? = null,
    /** Postgres text, not ISO: read with [InsightsDates.parse]. */
    val createdAt: String? = null,
)

@Serializable
data class CostAnalytics(
    val summary: CostSummary? = null,
    val forecast: CostForecast? = null,
    val dailyCosts: List<DailyCost>? = null,
    val costByRepo: List<CostByRepo>? = null,
    val costByType: List<CostByType>? = null,
    val costByModel: List<CostByModel>? = null,
    val anomalies: List<CostAnomaly>? = null,
    val modelSuggestions: List<ModelSuggestion>? = null,
    val topTasks: List<TopCostTask>? = null,
)

// endregion

// region Activity (apps/api/src/routes/activity.ts)

@Serializable
data class ActivityActor(
    val id: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
)

@Serializable
data class ActivityItem(
    val id: String,
    /** `action` / `task_event` / `auth_event` / `infra_event`. */
    val type: String = "action",
    val timestamp: String = "",
    val actor: ActivityActor? = null,
    val action: String = "",
    val resourceType: String = "",
    val resourceId: String? = null,
    val summary: String = "",
    val details: Map<String, JsonElement>? = null,
    /** Synthesised from a live `activity:new` frame, not yet in the feed. */
    @Transient val isLive: Boolean = false,
)

@Serializable
data class ActivityStats(
    val actions: Int = 0,
    val taskEvents: Int = 0,
    val authEvents: Int = 0,
    val infraEvents: Int = 0,
)

@Serializable
data class ActivityFeed(
    val items: List<ActivityItem> = emptyList(),
    val total: Int = 0,
    val stats: ActivityStats? = null,
)

// endregion

// region Cluster (apps/api/src/routes/cluster.ts)

@Serializable
data class ClusterNode(
    val name: String,
    val status: String? = null,
    val kubeletVersion: String? = null,
    val os: String? = null,
    val arch: String? = null,
    @Serializable(with = LooseDoubleSerializer::class) val cpu: Double? = null,
    val memory: String? = null,
    val containerRuntime: String? = null,
    @Serializable(with = LooseDoubleSerializer::class) val cpuPercent: Double? = null,
    @Serializable(with = LooseDoubleSerializer::class) val memoryUsedGi: Double? = null,
    @Serializable(with = LooseDoubleSerializer::class) val memoryTotalGi: Double? = null,
) {
    val isReady: Boolean
        get() = status == "Ready"

    val memoryPercent: Int?
        get() {
            val used = memoryUsedGi ?: return null
            val total = memoryTotalGi?.takeIf { it > 0 } ?: return null
            return Math.round(used / total * 100).toInt()
        }
}

@Serializable
data class ClusterPodInfo(
    val name: String,
    val phase: String? = null,
    val status: String? = null,
    val ready: Boolean? = null,
    val restarts: Int? = null,
    val image: String? = null,
    val nodeName: String? = null,
    val ip: String? = null,
    val startedAt: String? = null,
    val isOptioManaged: Boolean? = null,
    val isInfra: Boolean? = null,
    val cpuMillicores: Int? = null,
    val memoryMi: Int? = null,
) {
    /** The image's last path component (`ghcr.io/acme/optio-agent:1.2` → `optio-agent:1.2`). */
    val shortImage: String?
        get() = image?.substringAfterLast('/')
}

@Serializable
data class ClusterServicePort(
    val port: Int? = null,
    /** A number or a named port (Kubernetes IntOrString). */
    val targetPort: JsonElement? = null,
    @SerialName("protocol") val proto: String? = null,
) {
    val targetText: String
        get() = (targetPort as? JsonPrimitive)?.let { p ->
            p.stringValue ?: p.content.toDoubleOrNull()?.toLong()?.toString()
        } ?: "?"
}

@Serializable
data class ClusterService(
    val name: String? = null,
    val type: String? = null,
    val clusterIP: String? = null,
    val ports: List<ClusterServicePort>? = null,
)

@Serializable
data class ClusterEvent(
    val type: String? = null,
    val reason: String? = null,
    val message: String? = null,
    val involvedObject: String? = null,
    val count: Int? = null,
    val lastTimestamp: String? = null,
)

/** A task row as `/api/cluster/pods*` embeds it. */
@Serializable
data class PodTaskRow(
    val id: String,
    val title: String? = null,
    val state: String? = null,
    val agentType: String? = null,
    val createdAt: String? = null,
)

/** A `repo_pods` row enriched with live counters. */
@Serializable
data class RepoPodRecord(
    val id: String,
    val repoUrl: String? = null,
    val repoBranch: String? = null,
    val instanceIndex: Int? = null,
    val podName: String? = null,
    val podId: String? = null,
    val state: String? = null,
    val activeTaskCount: Int? = null,
    val queuedTaskCount: Int? = null,
    val maxConcurrentTasks: Int? = null,
    val maxPodInstances: Int? = null,
    val maxAgentsPerPod: Int? = null,
    val lastTaskAt: String? = null,
    val errorMessage: String? = null,
    val cachePvcName: String? = null,
    val cachePvcState: String? = null,
    val managedBy: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
    val recentTasks: List<PodTaskRow>? = null,
)

@Serializable
data class ClusterSummary(
    val totalPods: Int = 0,
    val runningPods: Int = 0,
    val agentPods: Int = 0,
    val infraPods: Int = 0,
    val totalNodes: Int = 0,
    val readyNodes: Int = 0,
)

@Serializable
data class ClusterOverview(
    val nodes: List<ClusterNode> = emptyList(),
    val pods: List<ClusterPodInfo> = emptyList(),
    val services: List<ClusterService> = emptyList(),
    val events: List<ClusterEvent> = emptyList(),
    val repoPods: List<RepoPodRecord> = emptyList(),
    val metricsAvailable: Boolean? = null,
    val summary: ClusterSummary = ClusterSummary(),
)

@Serializable
data class PodHealthEvent(
    val id: String,
    val repoPodId: String? = null,
    val repoUrl: String? = null,
    val eventType: String? = null,
    val podName: String? = null,
    val message: String? = null,
    val createdAt: String? = null,
)

@Serializable
data class K8sPodStatus(
    val phase: String? = null,
    val status: String? = null,
    val ready: Boolean? = null,
    val restarts: Int? = null,
    val image: String? = null,
    val ip: String? = null,
    val nodeName: String? = null,
    val startedAt: String? = null,
)

/** `GET /api/cluster/pods/:id` → the repo pod row plus live counters, its tasks and the K8s pod. */
@Serializable
data class RepoPodDetail(
    val id: String,
    val repoUrl: String? = null,
    val repoBranch: String? = null,
    val instanceIndex: Int? = null,
    val podName: String? = null,
    val podId: String? = null,
    val state: String? = null,
    val activeTaskCount: Int? = null,
    val lastTaskAt: String? = null,
    val errorMessage: String? = null,
    val cachePvcName: String? = null,
    val cachePvcState: String? = null,
    val managedBy: String? = null,
    val createdAt: String? = null,
    val tasks: List<PodTaskRow>? = null,
    val k8sPod: K8sPodStatus? = null,
)

@Serializable
data class ClusterVersion(
    val current: String? = null,
    val latest: String? = null,
    val updateAvailable: Boolean? = null,
)

// endregion

// region Envelopes

@Serializable
internal data class ClusterPodsEnvelope(val pods: List<RepoPodRecord> = emptyList())

@Serializable
internal data class ClusterPodEnvelope(val pod: RepoPodDetail)

@Serializable
internal data class HealthEventsEnvelope(val events: List<PodHealthEvent> = emptyList())

@Serializable
internal data class RepoUrlRow(
    val repoUrl: String? = null,
    val fullName: String? = null,
)

@Serializable
internal data class RepoUrlsEnvelope(val repos: List<RepoUrlRow> = emptyList())

// endregion
