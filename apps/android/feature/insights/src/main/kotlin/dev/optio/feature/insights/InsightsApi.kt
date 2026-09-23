package dev.optio.feature.insights

import dev.optio.core.network.ApiClient
import dev.optio.core.ui.format.InsightsFormat

// Endpoints of the Insights tab (iOS `InsightsAPI.swift`; `clusterOverview` from `OverviewAPI.swift`).

private fun analyticsQuery(days: Int, repoUrl: String? = null, agentType: String? = null): Map<String, Any?> =
    mapOf("days" to days, "repoUrl" to repoUrl, "agentType" to agentType)

suspend fun ApiClient.performanceAnalytics(days: Int, repoUrl: String? = null, agentType: String? = null): PerformanceAnalytics =
    get("/api/analytics/performance", analyticsQuery(days, repoUrl, agentType))

suspend fun ApiClient.agentAnalytics(days: Int, repoUrl: String? = null): AgentAnalytics =
    get("/api/analytics/agents", analyticsQuery(days, repoUrl))

suspend fun ApiClient.failureAnalytics(days: Int, repoUrl: String? = null, agentType: String? = null): FailureAnalytics =
    get("/api/analytics/failures", analyticsQuery(days, repoUrl, agentType))

suspend fun ApiClient.prAnalytics(days: Int, repoUrl: String? = null, agentType: String? = null): PrAnalytics =
    get("/api/analytics/prs", analyticsQuery(days, repoUrl, agentType))

suspend fun ApiClient.costAnalytics(days: Int, repoUrl: String? = null): CostAnalytics =
    get("/api/analytics/costs", analyticsQuery(days, repoUrl))

/** The unified activity feed (`GET /api/activity`), one page of [limit] from [offset]. */
suspend fun ApiClient.activityFeed(
    days: Int,
    type: String? = null,
    resourceType: String? = null,
    limit: Int = 50,
    offset: Int = 0,
): ActivityFeed = get(
    "/api/activity",
    mapOf("days" to days, "type" to type, "resourceType" to resourceType, "limit" to limit, "offset" to offset),
)

/** Nodes, pods, services, events and repo pods (`GET /api/cluster/overview`, admin only). */
suspend fun ApiClient.clusterOverview(): ClusterOverview = get("/api/cluster/overview")

suspend fun ApiClient.clusterPods(): List<RepoPodRecord> = get<ClusterPodsEnvelope>("/api/cluster/pods").pods

suspend fun ApiClient.clusterPod(id: String): RepoPodDetail = get<ClusterPodEnvelope>("/api/cluster/pods/$id").pod

suspend fun ApiClient.healthEvents(limit: Int = 50): List<PodHealthEvent> =
    get<HealthEventsEnvelope>("/api/cluster/health-events", mapOf("limit" to limit)).events

/** Destroys a repo pod; the next task recreates it (`POST /api/cluster/pods/:id/restart`). */
suspend fun ApiClient.restartClusterPod(id: String) {
    post("/api/cluster/pods/$id/restart")
}

suspend fun ApiClient.clusterVersion(): ClusterVersion = get("/api/cluster/version")

/** Repo URLs and names for the Costs repo filter. */
suspend fun ApiClient.repoUrls(): List<Pair<String, String>> =
    get<RepoUrlsEnvelope>("/api/repos").repos.mapNotNull { row ->
        val url = row.repoUrl ?: return@mapNotNull null
        url to (row.fullName ?: InsightsFormat.repoShortName(url))
    }
