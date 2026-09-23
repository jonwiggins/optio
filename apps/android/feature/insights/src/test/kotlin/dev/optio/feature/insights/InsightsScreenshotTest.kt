package dev.optio.feature.insights

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.unit.dp
import dev.optio.core.network.ApiError
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import java.time.Clock
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test

/**
 * Insights sections and the pod detail with data (charts included), loading, empty, error and
 * admin-only states, light and dark (`./gradlew :feature:insights:recordRoborazziDebug`).
 */
class InsightsScreenshotTest : ScreenshotTest() {
    private val padding = PaddingValues(bottom = 16.dp)

    /** The captured cluster data was recorded around this moment. */
    private val capturedClock: Clock = Clock.fixed(Instant.parse("2026-09-23T00:50:00Z"), ZoneOffset.UTC)

    private fun day(daysAgo: Int) = LocalDate.of(2026, 9, 22).minusDays(daysAgo.toLong()).toString()

    private val analytics = AnalyticsViewModel.Data(
        performance = PerformanceAnalytics(
            durations = PerformanceDurations(
                avgWallClock = 812.0,
                p50WallClock = 640.0,
                p95WallClock = 2400.0,
                avgExecution = 596.0,
                p50Execution = 480.0,
                p95Execution = 1890.0,
                avgQueueWait = 42.0,
                taskCount = 118,
            ),
            successRate = 81.0,
            successRateTrend = 6.0,
            tasksPerDay = (13 downTo 0).map { d ->
                val total = 4 + (d * 7 % 9)
                val failed = d % 4
                TasksPerDayPoint(day(d), total = total, succeeded = total - failed, failed = failed)
            },
        ),
        agents = AgentAnalytics(
            listOf(
                AgentAnalyticsRow(
                    "claude-code", 96, 84.0, 540.0, "0.4120", 0.21,
                    listOf(AgentModelStat("claude-sonnet-4-5", 80, "0.3100"), AgentModelStat("claude-opus-4-1", 16, "1.0200")),
                ),
                AgentAnalyticsRow("codex", 22, 45.0, 780.0, "0.2210", 0.8, listOf(AgentModelStat("gpt-5-codex", 22, "0.2210"))),
            ),
        ),
        failures = FailureAnalytics(
            errorMessages = listOf(
                ErrorMessageCount("Tests failed after 3 attempts", 9),
                ErrorMessageCount("Agent exited with code 1", 6),
                ErrorMessageCount("Error: connect ECONNREFUSED 127.0.0.1:5432", 3),
                ErrorMessageCount("Pod OOMKilled", 2),
            ),
            failureByRepo = listOf(
                FailureByRepo("https://github.com/acme/web", 70, 9, 13.0),
                FailureByRepo("https://github.com/acme/api", 38, 13, 34.0),
            ),
            failureByModel = listOf(
                FailureByModel("claude-sonnet-4-5", 80, 10, 13.0),
                FailureByModel("gpt-5-codex", 22, 12, 55.0),
            ),
            retrySuccessRate = 62.0,
            retriedCount = 13,
            retrySucceededCount = 8,
            stallCount = 3,
            stallRecoveryRate = 67.0,
        ),
        prs = PrAnalytics(
            totalPrs = 64,
            merged = 41,
            closed = 6,
            open = 17,
            ciPassRate = 78.0,
            reviewApprovalRate = 70.0,
            autoMergeRate = 64.0,
            avgMergeTime = 15840.0,
            mergeCount = 41,
            funnel = PrFunnel(64, 50, 45, 41),
        ),
    )

    private val costs = CostAnalytics(
        summary = CostSummary("48.2310", 118, 112, "0.4306", "12.4", "42.9100", 30),
        forecast = CostForecast("1.6077", "33.1200", "49.8400", 8),
        dailyCosts = (29 downTo 0).map { d -> DailyCost(day(d), cost = 0.6 + (d * 13 % 11) * 0.21, taskCount = 3 + d % 5) },
        costByRepo = listOf(
            CostByRepo("https://github.com/acme/web", 29.4, 71),
            CostByRepo("https://github.com/acme/api", 14.2, 38),
            CostByRepo("job:Nightly release notes", 3.1, 30),
            CostByRepo("/Users/dev/src/scratch", 1.5, 4),
        ),
        costByType = listOf(
            CostByType("coding", 36.4, 82),
            CostByType("review", 6.9, 24),
            CostByType("job", 3.4, 31),
            CostByType("local-session", 1.5, 4),
        ),
        costByModel = listOf(
            CostByModel("claude-sonnet-4-5", 31.2, 88, 84.0, 0.35, 4_820_000.0, 391_000.0),
            CostByModel("claude-opus-4-1", 14.9, 12, 92.0, 1.24, 1_120_000.0, 88_000.0),
            CostByModel("gpt-5-codex", 2.1, 18, 45.0, 0.12, 610_000.0, 41_000.0),
        ),
        anomalies = listOf(
            CostAnomaly("t-anom", "Rewrite the billing importer", "https://github.com/acme/api", "coding", "completed", "6.8200", "claude-opus-4-1", 1.21, 5.6, "2026-09-21 13:02:11.12+00"),
        ),
        modelSuggestions = listOf(ModelSuggestion("https://github.com/acme/api", "claude-opus-4-1", 12, 1.24, 0.38)),
        topTasks = listOf(
            TopCostTask("t-anom", "Rewrite the billing importer", "https://github.com/acme/api", "coding", "completed", "6.8200", 812_000.0, 64_000.0, "claude-opus-4-1", "2026-09-21 13:02:11.12+00"),
            TopCostTask("t2", "Migrate the image cache to Coil 3", "https://github.com/acme/web", "coding", "pr_opened", "2.1400", 301_000.0, 22_000.0, "claude-sonnet-4-5", "2026-09-22 09:12:40.5+00"),
            TopCostTask("t3", "Review: Paginate the activity feed", "https://github.com/acme/web", "review", "completed", "0.4213", 48_211.0, 2_210.0, "claude-sonnet-4-5", "2026-09-22 16:05:00+00"),
            TopCostTask("r1", "Nightly release notes", "job:Nightly release notes", "job", "completed", "0.0520", 9_100.0, 900.0, "claude-haiku-4-5", "2026-09-22 03:00:05+00"),
        ),
    )

    @Test
    fun analytics() = captureScreens("Analytics", size = ScreenSize.TALL) {
        AnalyticsContent(state = LoadState.Loaded(analytics), days = 14, contentPadding = padding)
    }

    @Test
    fun analyticsFromTheTestApi() {
        val captured = AnalyticsViewModel.Data(
            Fixtures.decode("analytics-performance.json"),
            Fixtures.decode("analytics-agents.json"),
            Fixtures.decode("analytics-failures.json"),
            Fixtures.decode("analytics-prs.json"),
        )
        captureScreens("AnalyticsCaptured", size = ScreenSize.TALL, clock = capturedClock) {
            AnalyticsContent(state = LoadState.Loaded(captured), days = 30, contentPadding = padding)
        }
    }

    @Test
    fun analyticsStates() {
        captureScreens("AnalyticsLoading") { AnalyticsContent(state = LoadState.Loading(), days = 30, contentPadding = padding) }
        captureScreens("AnalyticsForbidden") {
            AnalyticsContent(state = LoadState.Failed(ApiError(403, "Insufficient permissions")), days = 30, contentPadding = padding)
        }
        captureScreens("AnalyticsError") {
            AnalyticsContent(state = LoadState.Failed(ApiError(502, "bad gateway")), days = 30, contentPadding = padding)
        }
    }

    @Test
    fun costs() = captureScreens("Costs", size = ScreenSize.TALL) {
        CostsContent(state = LoadState.Loaded(costs), filter = CostsViewModel.Filter(), contentPadding = padding)
    }

    @Test
    fun costsFromTheTestApi() = captureScreens("CostsCaptured", size = ScreenSize.TALL, clock = capturedClock) {
        CostsContent(
            state = LoadState.Loaded(Fixtures.decode("analytics-costs.json")),
            filter = CostsViewModel.Filter(repoUrl = "https://github.com/e2e-org/e2e-repo"),
            contentPadding = padding,
        )
    }

    /** A repo filter the API fails on (`repoUrl` 500s on current main): the old numbers stay, flagged. */
    @Test
    fun costsStale() = captureScreens("CostsStale") {
        CostsContent(
            state = LoadState.Failed(ApiError(500, "Internal Server Error"), previous = costs),
            filter = CostsViewModel.Filter(repoUrl = "https://github.com/acme/api"),
            contentPadding = padding,
            shownFilter = CostsViewModel.Filter(),
        )
    }

    @Test
    fun costsEmpty() = captureScreens("CostsEmpty") {
        CostsContent(
            state = LoadState.Loaded(CostAnalytics(summary = CostSummary("0.0000", 0, 0, "0.0000", "0.0", "0.0000", 7), forecast = CostForecast("0", "0", "0", 8))),
            filter = CostsViewModel.Filter(days = 7),
            contentPadding = padding,
        )
    }

    @Test
    fun activity() {
        val feed = Fixtures.decode<ActivityFeed>("activity.json")
        val live = ActivityItem(
            id = "live-1",
            type = "action",
            timestamp = Samples.agoIso(0),
            action = "repo.update",
            resourceType = "repo",
            summary = "repo.update succeeded",
            isLive = true,
        )
        val page = ActivityViewModel.Page(listOf(live) + feed.items, feed.total + 1, feed.stats!!.let { it.copy(actions = it.actions + 1) })
        captureScreens("Activity", size = ScreenSize.TALL) {
            ActivityContent(state = LoadState.Loaded(page), filter = ActivityViewModel.Filter(), live = true, contentPadding = padding)
        }
    }

    @Test
    fun activityStates() {
        captureScreens("ActivityError") {
            ActivityContent(
                state = LoadState.Failed(ApiError(500, "Failed to fetch activity feed")),
                filter = ActivityViewModel.Filter(),
                live = true,
                contentPadding = padding,
            )
        }
        captureScreens("ActivityEmpty") {
            ActivityContent(
                state = LoadState.Loaded(ActivityViewModel.Page(emptyList(), 0, ActivityStats())),
                filter = ActivityViewModel.Filter(days = 1, type = "auth_event"),
                live = false,
                contentPadding = padding,
            )
        }
        captureScreens("ActivityForbidden") {
            ActivityContent(state = LoadState.Failed(ApiError(403, "Insufficient permissions")), filter = ActivityViewModel.Filter(), live = false, contentPadding = padding)
        }
    }

    private val cluster = ClusterViewModel.State(
        overview = Fixtures.decode("cluster-overview.json"),
        repoPods = Fixtures.decode<ClusterPodsEnvelope>("cluster-pods.json").pods,
        healthEvents = Fixtures.decode<HealthEventsEnvelope>("cluster-health-events.json").events,
        version = ClusterVersion(current = "0.4.2", latest = "0.5.0", updateAvailable = true),
        loading = false,
    )

    @Test
    fun cluster() {
        captureScreens("Cluster", size = ScreenSize.TALL, clock = capturedClock) { ClusterContent(state = cluster, contentPadding = padding) }
    }

    @Test
    fun clusterTabs() {
        ClusterViewModel.Tab.entries.drop(1).forEach { tab ->
            captureScreens("Cluster${tab.name.lowercase().replaceFirstChar { it.uppercase() }.replace("_pods", "Pods")}", clock = capturedClock) {
                ClusterContent(state = cluster.copy(tab = tab), contentPadding = padding)
            }
        }
    }

    @Test
    fun clusterStates() {
        captureScreens("ClusterForbidden") {
            ClusterContent(state = ClusterViewModel.State(forbidden = true, loading = false, version = ClusterVersion("dev", "0.5.0", false)), contentPadding = padding)
        }
        captureScreens("ClusterLoading") { ClusterContent(state = ClusterViewModel.State(), contentPadding = padding) }
        captureScreens("ClusterError") {
            ClusterContent(state = ClusterViewModel.State(error = ApiError(500, "Error: connect ECONNREFUSED"), loading = false), contentPadding = padding)
        }
    }

    @Test
    fun podDetail() {
        val pod = Fixtures.decode<ClusterPodEnvelope>("cluster-pod.json").pod.copy(
            k8sPod = K8sPodStatus(
                phase = "Running",
                status = "Running",
                ready = true,
                restarts = 1,
                image = "ghcr.io/jonwiggins/optio-agent-node:0.5.0",
                ip = "10.1.0.31",
                nodeName = "docker-desktop",
                startedAt = "2026-09-22T22:47:35.155Z",
            ),
            cachePvcName = "optio-cache-e2e-repo",
            cachePvcState = "bound",
        )
        val events = Fixtures.decode<HealthEventsEnvelope>("cluster-health-events.json").events.filter { it.repoPodId == pod.id }
        captureScreens("PodDetail", size = ScreenSize.TALL, clock = capturedClock) {
            PodDetailContent(state = LoadState.Loaded(PodDetailViewModel.Data(pod, events)), restarting = false, canRestart = true)
        }
        captureScreens("PodDetailForbidden") {
            PodDetailContent(state = LoadState.Failed(ApiError(403, "Insufficient permissions")), restarting = false, canRestart = false)
        }
    }
}
