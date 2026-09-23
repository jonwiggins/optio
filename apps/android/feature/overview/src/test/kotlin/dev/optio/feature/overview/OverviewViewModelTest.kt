package dev.optio.feature.overview

import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.testing.Samples
import dev.optio.core.workfeed.WorkFeed
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.withTimeout
import org.junit.Rule

/** The Overview's model against the captured seed: every source, partial failures, metrics. */
@OptIn(ExperimentalCoroutinesApi::class)
class OverviewViewModelTest {
    @get:Rule
    val main = MainDispatcherRule(UnconfinedTestDispatcher())

    private val server = FakeOptioServer().start()

    @AfterTest
    fun tearDown() = server.close()

    private fun vm() = OverviewViewModel(api = server.client(), feedLoad = { OverviewSeed.feedSources }, clock = OverviewSeed.clock)

    @Test
    fun refreshLoadsEverySource() = runBlocking<Unit> {
        OverviewSeed.serve(server)
        val vm = vm()
        vm.refresh()
        with(vm.dashboard.value) {
            assertFalse(loading)
            assertNull(error)
            assertEquals(10, taskStats?.total)
            assertEquals(1, taskStats?.needsAttention)
            assertEquals(5, recentTasks.size)
            assertEquals(listOf("Tidy up the config loader"), attentionTasks.map { it.title })
            assertEquals(2, repoCount)
            assertEquals("docker-desktop", cluster?.nodes?.single()?.name)
            assertEquals(6, cluster?.summary?.totalPods)
            assertFalse(clusterForbidden)
            assertEquals(1, metricsHistory.size)
            assertEquals(23.0, metricsHistory.single().cpuPercent)
            assertEquals(28.0, metricsHistory.single().memoryPercent, "8.8 of 31.4 Gi, rounded")
            assertEquals(OverviewSeed.clock.instant(), metricsHistory.single().time)
            assertEquals(1, localHosts.size)
            assertEquals(4, localTerminals.size)
            assertFalse(isFirstRun)
            assertTrue(hasLocal)
            assertEquals(0, localHostsOnline, "the seed laptop is offline")
            assertTrue(localNeedsYou.isEmpty(), "finished and pending terminals don't wait on you")
            assertEquals(0.214 + 0.4213, totalRecentCost, 1e-9)
        }
        assertEquals("needs_attention", server.requests("GET", "/api/tasks").firstOrNull { it.queryParam("state") != null }?.queryParam("state"))
        assertEquals("5", server.requests("GET", "/api/tasks").firstOrNull { it.queryParam("state") == null && it.queryParam("type") == null }?.queryParam("limit"))
    }

    @Test
    fun theClusterIsForbiddenForNonAdminsAndOtherFailuresKeepTheLastValues() = runBlocking<Unit> {
        OverviewSeed.serve(server)
        val vm = vm()
        vm.refresh()
        val first = vm.dashboard.value

        server.error("GET", "/api/cluster/overview", 403, "Admin role required")
        server.error("GET", "/api/local/hosts", 500, "boom")
        server.error("GET", "/api/repos", 500, "boom")
        vm.refresh()
        with(vm.dashboard.value) {
            assertTrue(clusterForbidden)
            assertEquals(first.localHosts, localHosts, "a failed host list keeps the last one")
            assertEquals(2, repoCount)
            assertEquals(1, metricsHistory.size, "no new sample without an answer")
        }

        server.error("GET", "/api/cluster/overview", 502, "Bad gateway")
        vm.refresh()
        with(vm.dashboard.value) {
            assertFalse(clusterForbidden)
            assertNotNull(cluster, "the last cluster stays after a transient failure")
        }
    }

    @Test
    fun aFailedStatsCallIsTheErrorButKeepsTheLastStats() = runBlocking<Unit> {
        OverviewSeed.serve(server)
        val vm = vm()
        vm.refresh()
        server.error("GET", "/api/tasks/stats", 500, "Database unavailable")
        vm.refresh()
        with(vm.dashboard.value) {
            assertEquals("Database unavailable", error?.message)
            assertEquals(10, taskStats?.total)
            assertFalse(isFirstRun)
        }
        server.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        vm.refresh()
        assertNull(vm.dashboard.value.error)
    }

    @Test
    fun aDeadServerFailsTheFirstLoad() = runBlocking<Unit> {
        server.on("*", "/api/*") { FakeResponse.error(503, "Service unavailable") }
        val vm = vm()
        vm.refresh()
        with(vm.dashboard.value) {
            assertFalse(loading)
            assertNull(taskStats)
            assertEquals("Service unavailable", error?.message)
            assertTrue(isFirstRun, "nothing loaded: the screen shows the error, not the welcome")
        }
    }

    @Test
    fun theMetricsHistoryKeepsTenMinutes() = runBlocking<Unit> {
        OverviewSeed.serve(server)
        val vm = vm()
        repeat(OverviewViewModel.MAX_HISTORY + 5) { vm.refresh() }
        assertEquals(OverviewViewModel.MAX_HISTORY, vm.dashboard.value.metricsHistory.size)
    }

    @Test
    fun startRefreshesNowAndStopEndsIt() = runBlocking<Unit> {
        OverviewSeed.serve(server)
        val vm = vm()
        vm.start()
        withTimeout(10_000) { vm.dashboard.first { !it.loading } }
        withTimeout(10_000) { vm.feed.first { !it.loading } }
        assertEquals(WorkFeed.collect(OverviewSeed.feedSources).size, vm.feed.value.rows.size)
        vm.stop()
        val requests = server.requests.size
        Thread.sleep(300)
        assertEquals(requests, server.requests.size, "stopped: no more requests")
    }

    @Test
    fun needsYouAndFirstRunDerivations() {
        val host = Samples.localHost(id = "h1", state = LocalHostState.ONLINE)
        val waitingLong = Samples.localTerminal(id = "old", hostId = "h1", lastActivityAt = Samples.agoIso(30))
        val waitingShort = Samples.localTerminal(id = "new", hostId = "h1", lastActivityAt = Samples.agoIso(2))
        val idleShell = Samples.localTerminal(id = "idle", attentionState = LocalAttentionState.IDLE, lastActivityAt = Samples.agoIso(10))
        val finished = Samples.localTerminal(id = "done", state = LocalTerminalState.EXITED, exitCode = 0)
        val working = Samples.localTerminal(id = "busy", attentionState = LocalAttentionState.WORKING)
        val d = OverviewDashboard(
            taskStats = DashTaskStats(total = 0),
            localHosts = listOf(host),
            localTerminals = listOf(waitingShort, finished, working, waitingLong, idleShell),
            loading = false,
        )
        assertEquals(listOf("old", "idle", "new"), d.localNeedsYou.map { it.id }, "oldest wait first; a running idle shell waits too")
        assertFalse(d.isFirstRun, "an open terminal counts as started")
        assertTrue(OverviewDashboard(taskStats = DashTaskStats(total = 0)).isFirstRun)
        assertEquals(1, d.localHostsOnline)
        assertEquals(mapOf("h1" to "mbp"), d.localHostName)
    }
}
