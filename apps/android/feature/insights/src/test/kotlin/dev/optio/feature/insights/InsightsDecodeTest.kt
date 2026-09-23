package dev.optio.feature.insights

import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.theme.Tone
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Insights JSON captured from the private test API (and a few built from the route code), plus the pure helpers. */
class InsightsDecodeTest {
    @Test
    fun analyticsDecode() {
        val perf = Fixtures.decode<PerformanceAnalytics>("analytics-performance.json")
        assertEquals(44.0, perf.successRate)
        assertEquals(7.0, perf.durations?.avgExecution)
        assertEquals(2, perf.durations?.taskCount)
        assertEquals("2026-09-23", perf.tasksPerDay?.single()?.date)
        assertEquals(4, perf.tasksPerDay?.single()?.succeeded)

        val agents = Fixtures.decode<AgentAnalytics>("analytics-agents.json").agents!!
        assertEquals("claude-code", agents.single().agentType)
        assertEquals("0.3428", agents.single().avgCost)
        assertEquals(listOf("fake-model", "unknown"), agents.single().models?.map { it.model })

        val failures = Fixtures.decode<FailureAnalytics>("analytics-failures.json")
        assertEquals("Mock agent failure", failures.errorMessages?.single()?.message)
        assertEquals(13.0, failures.failureByRepo?.single()?.failureRate)
        assertEquals(2, failures.failureByModel?.size)
        assertEquals(0, failures.stallCount)

        val prs = Fixtures.decode<PrAnalytics>("analytics-prs.json")
        assertEquals(4, prs.totalPrs)
        assertEquals(4, prs.funnel?.prOpened)
    }

    @Test
    fun costsDecodeWithPostgresDates() {
        val costs = Fixtures.decode<CostAnalytics>("analytics-costs.json")
        assertEquals("2.1521", costs.summary?.totalCost)
        assertEquals(30, costs.summary?.days)
        assertEquals("19.3689", costs.forecast?.forecastedMonthTotal)
        assertEquals(2.1521, costs.dailyCosts?.single()?.cost)
        assertEquals(listOf("coding", "review", "job", "local-session"), costs.costByType?.map { it.taskType })
        assertEquals(18342.0, costs.costByModel?.last()?.totalInputTokens)
        val top = costs.topTasks!!.first()
        assertEquals("Paginate the activity feed", top.title)
        assertEquals("2026-09-23 00:47:43.464027+00", top.createdAt, "raw SQL rows carry Postgres text")
        assertEquals(Instant.parse("2026-09-23T00:47:43.464027Z"), InsightsDates.parse(top.createdAt))
        assertTrue(costs.anomalies!!.isEmpty())
        assertEquals(TaskDetailRoute(top.id), top.route())
        assertEquals("job:Nightly release notes", costs.costByRepo?.get(1)?.repoUrl)
    }

    @Test
    fun activityDecodes() {
        val feed = Fixtures.decode<ActivityFeed>("activity.json")
        assertEquals(127, feed.total)
        assertEquals(ActivityStats(actions = 64, taskEvents = 58, authEvents = 1, infraEvents = 4), feed.stats)
        val first = feed.items.first()
        assertEquals("Ada Admin", first.actor?.displayName)
        assertEquals(setOf("taskId", "reason"), first.details?.keys)
        assertFalse(first.isLive)
        assertEquals(TaskDetailRoute("5f1c2a9e-8d7b-4c3e-9a1f-2b6d8e4c7a10"), first.route())
        assertNull(feed.items[2].route(), "pods have no screen here")
        assertNull(feed.items.last().details)
        // The API's error body on the 500 it answers today (apps/api/src/routes/activity.ts).
        assertEquals(mapOf("error" to "Failed to fetch activity feed"), OptioJson.decodeFromString<Map<String, String>>(Fixtures.text("activity-error.json")))
    }

    @Test
    fun clusterDecodes() {
        val ov = Fixtures.decode<ClusterOverview>("cluster-overview.json")
        val node = ov.nodes.single()
        assertEquals(10.0, node.cpu, "a numeric string")
        assertEquals(23.0, node.cpuPercent)
        assertEquals(8.8, node.memoryUsedGi)
        assertEquals(28, node.memoryPercent)
        assertTrue(node.isReady)
        assertEquals(6, ov.pods.size)
        val crashing = ov.pods.first { it.status == "CrashLoopBackOff" }
        assertEquals(4, crashing.restarts)
        assertEquals("optio-agent-node:latest", crashing.shortImage)
        assertEquals("4000", ov.services.first().ports!!.single().targetText)
        assertEquals("Warning", ov.events.first().type)
        assertEquals(1, ov.repoPods.last().queuedTaskCount)
        assertEquals(ClusterSummary(totalPods = 6, runningPods = 5, agentPods = 2, infraPods = 2, totalNodes = 1, readyNodes = 1), ov.summary)
        assertEquals(true, ov.metricsAvailable)

        val pods = Fixtures.decode<ClusterPodsEnvelope>("cluster-pods.json").pods
        assertEquals("Migrate the image cache to Coil 3", pods.first().recentTasks?.single()?.title)
        val pod = Fixtures.decode<ClusterPodEnvelope>("cluster-pod.json").pod
        assertEquals("optio-repo-e2e-org-e2e-repo-317e", pod.podName)
        assertNull(pod.k8sPod, "the fake cluster has no pod by that name")
        assertEquals(9, pod.tasks?.size)
        assertTrue(Fixtures.decode<HealthEventsEnvelope>("cluster-health-events-empty.json").events.isEmpty())
        assertEquals(3, Fixtures.decode<HealthEventsEnvelope>("cluster-health-events.json").events.size)
        val version = Fixtures.decode<ClusterVersion>("cluster-version.json")
        assertEquals("dev", version.current)
        assertEquals(false, version.updateAvailable)
    }

    @Test
    fun looseNumbersAndNamedPorts() {
        val node = OptioJson.decodeFromString<ClusterNode>("""{"name":"n","cpu":"4.5","memoryUsedGi":null,"memoryTotalGi":"abc","cpuPercent":"n/a"}""")
        assertEquals(4.5, node.cpu)
        assertNull(node.memoryUsedGi)
        assertNull(node.memoryTotalGi)
        assertNull(node.cpuPercent)
        assertNull(node.memoryPercent)
        val port = OptioJson.decodeFromString<ClusterServicePort>("""{"port":80,"targetPort":"http","protocol":"TCP"}""")
        assertEquals("http", port.targetText)
        assertEquals("TCP", port.proto)
    }

    @Test
    fun dates() {
        assertEquals(Instant.parse("2026-09-22T16:00:00Z"), InsightsDates.parse("2026-09-22T16:00:00.000Z"))
        assertEquals(Instant.parse("2026-09-22T16:00:00Z"), InsightsDates.parse("2026-09-22 18:00:00+02"))
        assertNull(InsightsDates.parse("soon"))
        assertNull(InsightsDates.parse(null))
        assertEquals(LocalDate.parse("2026-09-17").toEpochDay(), epochDay("2026-09-17"))
        assertEquals(LocalDate.parse("2026-09-17").toEpochDay(), epochDay("2026-09-17T00:00:00.000Z"))
    }

    @Test
    fun chartScales() {
        assertEquals(1.0, ChartScale.niceStep(3.0, integers = true))
        assertEquals(2.0, ChartScale.niceStep(7.0, integers = true))
        assertEquals(5.0, ChartScale.niceStep(17.0, integers = true))
        assertEquals(10.0, ChartScale.niceStep(40.0, integers = true))
        assertEquals(1.0, ChartScale.niceStep(2.1521))
        assertEquals(0.05, ChartScale.niceStep(0.18), 1e-9)
        assertEquals(1.0, ChartScale.niceStep(0.0))
        assertEquals(3.0, ChartScale.niceMax(2.1521, 1.0))
        assertEquals(2.5, ChartScale.niceMax(2.1521, 0.5))
        assertEquals(3.0, ChartScale.niceMax(0.0, 3.0), "never below one step")
        assertEquals(100L - 6, ChartScale.minDay(listOf(100L)), "one bucket still spans a week")
        assertEquals(70L, ChartScale.minDay(listOf(70L, 100L)))
        assertEquals(1, ChartScale.labelSpacing(1, 5))
        assertEquals(6, ChartScale.labelSpacing(1, 30))
        assertEquals("Sep 17", ChartScale.dayLabel(LocalDate.parse("2026-09-17").toEpochDay().toDouble()))
    }

    @Test
    fun formattingHelpers() {
        assertEquals("Mock agent failure", shortMessage("  Mock agent failure "))
        assertEquals("Error: connect ECONNREFUSED…", shortMessage("Error: connect ECONNREFUSED 127.0.0.1:5432"))
        assertEquals(Tone.DANGER, ClusterViewModel.statusTone("CrashLoopBackOff"))
        assertEquals(Tone.SUCCESS, ClusterViewModel.statusTone("ready"))
        assertEquals(Tone.WORKING, ClusterViewModel.statusTone("provisioning"))
        assertEquals(Tone.IDLE, ClusterViewModel.statusTone(null))
        assertEquals(LocalTerminalRoute("lt"), TopCostTask(id = "lt", taskType = "local-session").route())
        assertNull(TopCostTask(id = "run", taskType = "job").route(), "a job run id isn't a job id")
        val details = prettyDetails(mapOf("b" to kotlinx.serialization.json.JsonPrimitive(2), "a" to kotlinx.serialization.json.JsonPrimitive("x")))
        assertEquals("{\n  \"a\": \"x\",\n  \"b\": 2\n}", details, "sorted keys, two-space indent")
    }

    @Test
    fun activityGroupsByDay() {
        val now = Instant.parse("2026-09-22T16:40:00Z")
        val items = Fixtures.decode<ActivityFeed>("activity.json").items + ActivityItem(id = "odd", timestamp = "whenever")
        val groups = groupByDay(items, now, ZoneOffset.UTC)
        assertEquals(listOf("Today", "Yesterday", "Unknown date"), groups.map { it.first })
        assertEquals(3, groups[0].second.size)
        assertEquals(2, groups[1].second.size)
    }
}
