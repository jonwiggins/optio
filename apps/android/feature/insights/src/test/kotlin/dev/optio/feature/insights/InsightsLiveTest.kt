package dev.optio.feature.insights

import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Assume.assumeTrue

/**
 * The Insights endpoints against a live private test API (DevLab seed, auth disabled, the fake
 * Kubernetes API). Read-only. Runs only with `OPTIO_TEST_API_URL`, e.g. `http://127.0.0.1:4965`.
 */
class InsightsLiveTest {
    private fun api(): ApiClient {
        val url = System.getenv("OPTIO_TEST_API_URL")
        assumeTrue("OPTIO_TEST_API_URL not set", !url.isNullOrBlank())
        return ApiClient(url, System.getenv("OPTIO_TEST_API_TOKEN") ?: "dev")
    }

    @Test
    fun analytics() = runTest {
        val api = api()
        for (days in listOf(7, 30)) {
            val perf = api.performanceAnalytics(days)
            assertNotNull(perf.durations)
            assertTrue(perf.tasksPerDay!!.isNotEmpty(), "the seed ran tasks today")
            assertTrue(api.agentAnalytics(days).agents!!.any { it.agentType == "claude-code" })
            assertNotNull(api.failureAnalytics(days).errorMessages)
            assertTrue((api.prAnalytics(days).totalPrs ?: 0) > 0, "the seed opened PRs")
        }
    }

    @Test
    fun costs() = runTest {
        val api = api()
        val costs = api.costAnalytics(30)
        assertTrue((costs.summary?.totalCost?.toDouble() ?: 0.0) > 0)
        assertTrue(costs.dailyCosts!!.isNotEmpty())
        assertTrue(costs.topTasks!!.all { InsightsDates.parse(it.createdAt) != null }, "every top task's date parses")
        val repos = api.repoUrls()
        assertTrue(repos.any { it.second == "e2e-org/e2e-repo" })
        assertEquals(7, api.costAnalytics(7).summary?.days)
        // Filtering by repo 500s on current main: the anomalies query joins a CTE that also has
        // `repo_url`, so the unqualified filter is ambiguous (apps/api/src/routes/analytics.ts, the
        // `repo_avgs` query's `${repoFilter}`). The screen shows its error row over the old numbers.
        try {
            assertEquals(7, api.costAnalytics(7, repos.first().first).summary?.days)
        } catch (e: ApiError) {
            assertEquals(500, e.status)
            assertTrue("repo_avgs" in e.body.orEmpty(), e.body)
        }
    }

    @Test
    fun cluster() = runTest {
        val api = api()
        val ov = api.clusterOverview()
        assertEquals("docker-desktop", ov.nodes.single().name)
        assertTrue(ov.pods.any { it.status == "CrashLoopBackOff" }, "the fake cluster has a crashing pod")
        assertTrue(ov.services.isNotEmpty())
        val pods = api.clusterPods()
        assertTrue(pods.isNotEmpty())
        val pod = api.clusterPod(pods.first().id)
        assertEquals(pods.first().id, pod.id)
        assertNotNull(api.healthEvents(50))
        assertNotNull(api.clusterVersion().current)
    }

    /** `/api/activity` 500s on current main (a server fix is on its own branch); either answer is handled. */
    @Test
    fun activity() = runTest {
        val api = api()
        try {
            val feed = api.activityFeed(days = 7)
            assertTrue(feed.total >= feed.items.size)
        } catch (e: ApiError) {
            assertEquals(500, e.status)
            assertEquals("Failed to fetch activity feed", e.message)
        }
    }
}
