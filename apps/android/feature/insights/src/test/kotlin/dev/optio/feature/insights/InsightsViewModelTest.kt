package dev.optio.feature.insights

import androidx.lifecycle.viewModelScope
import dev.optio.core.model.ActivityNewEvent
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeRequest
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import org.junit.Rule

/** The Insights models against the fake API (iOS `AnalyticsModel`, `CostsModel`, `ActivityModel`, `ClusterModel`). */
@OptIn(ExperimentalCoroutinesApi::class)
class InsightsViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    private suspend fun FakeOptioServer.next(method: String, path: String): FakeRequest =
        withContext(Dispatchers.IO) { awaitRequest(method, path) }

    private fun analyticsRoutes() {
        server.fixture("/api/analytics/performance", "analytics-performance.json")
        server.fixture("/api/analytics/agents", "analytics-agents.json")
        server.fixture("/api/analytics/failures", "analytics-failures.json")
        server.fixture("/api/analytics/prs", "analytics-prs.json")
    }

    @Test
    fun analyticsLoadsFourRoutesForThePeriod() = runTest(main.dispatcher) {
        analyticsRoutes()
        val vm = AnalyticsViewModel(server.client())
        vm.reload()
        val data = vm.state.value.value!!
        assertEquals(44.0, data.performance.successRate)
        assertEquals(1, data.agents.agents?.size)
        assertEquals(4, data.prs.totalPrs)
        listOf("performance", "agents", "failures", "prs").forEach { route ->
            assertEquals("30", server.lastRequest("GET", "/api/analytics/$route")!!.queryParam("days"))
        }
        server.clearRequests()
        vm.setDays(7)
        assertEquals("7", server.next("GET", "/api/analytics/performance").queryParam("days"))
        vm.state.first { it is LoadState.Loaded }
        vm.setDays(7)
        vm.state.first { it is LoadState.Loaded }
        assertEquals(1, server.count("GET", "/api/analytics/performance"), "the same period doesn't refetch")
        vm.viewModelScope.cancel()
    }

    @Test
    fun analyticsForViewersIsForbidden() = runTest(main.dispatcher) {
        analyticsRoutes()
        server.error("GET", "/api/analytics/failures", 403, "Insufficient permissions")
        val vm = AnalyticsViewModel(server.client())
        vm.reload()
        val failed = assertIs<LoadState.Failed<*>>(vm.state.value)
        assertTrue(failed.error.isForbidden)
        vm.viewModelScope.cancel()
    }

    @Test
    fun costsFilterByPeriodAndRepo() = runTest(main.dispatcher) {
        server.fixture("/api/analytics/costs", "analytics-costs.json")
        server.json("/api/repos", """{"repos":[{"id":"r1","repoUrl":"https://github.com/e2e-org/e2e-repo","fullName":"e2e-org/e2e-repo"},{"id":"r2","repoUrl":"https://github.com/e2e-org/mobile-app"},{"id":"r3"}]}""")
        val vm = CostsViewModel(server.client())
        vm.reload()
        assertEquals("2.1521", vm.state.value.value?.summary?.totalCost)
        assertEquals(
            listOf("https://github.com/e2e-org/e2e-repo" to "e2e-org/e2e-repo", "https://github.com/e2e-org/mobile-app" to "e2e-org/mobile-app"),
            vm.repos.value,
            "a repo without a URL is skipped; a missing name falls back to owner/repo",
        )
        val first = server.lastRequest("GET", "/api/analytics/costs")!!
        assertEquals("30", first.queryParam("days"))
        assertNull(first.queryParam("repoUrl"))

        vm.setRepo("https://github.com/e2e-org/mobile-app")
        vm.state.first { it is LoadState.Loading }
        vm.state.first { it is LoadState.Loaded }
        assertEquals("https://github.com/e2e-org/mobile-app", server.lastRequest("GET", "/api/analytics/costs")!!.queryParam("repoUrl"))
        vm.setDays(90)
        vm.state.first { it is LoadState.Loading }
        vm.state.first { it is LoadState.Loaded }
        val last = server.lastRequest("GET", "/api/analytics/costs")!!
        assertEquals("90", last.queryParam("days"))
        assertEquals("https://github.com/e2e-org/mobile-app", last.queryParam("repoUrl"))
        assertEquals(1, server.count("GET", "/api/repos"), "repos are fetched once")
        assertEquals(CostsViewModel.Filter(90, "https://github.com/e2e-org/mobile-app"), vm.shown.value)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aFailedRepoFilterKeepsTheEarlierCostsLabelledAsTheyWere() = runTest(main.dispatcher) {
        server.fixture("/api/analytics/costs", "analytics-costs.json")
        server.json("/api/repos", """{"repos":[]}""")
        val vm = CostsViewModel(server.client())
        vm.reload()
        assertEquals(CostsViewModel.Filter(), vm.shown.value)
        // `repoUrl` 500s on the current API (an ambiguous column in the anomalies query).
        server.error("GET", "/api/analytics/costs", 500, "Internal Server Error")
        vm.setRepo("https://github.com/e2e-org/mobile-app")
        vm.state.first { it is LoadState.Failed }
        assertEquals("2.1521", vm.state.value.value?.summary?.totalCost, "the earlier numbers stay up")
        assertEquals("https://github.com/e2e-org/mobile-app", vm.filter.value.repoUrl, "the menu keeps the choice")
        assertEquals(CostsViewModel.Filter(), vm.shown.value, "what's on screen is still all repos")
        vm.viewModelScope.cancel()
    }

    private fun activityModel(live: MutableSharedFlow<ActivityNewEvent> = MutableSharedFlow(extraBufferCapacity = 8)) =
        ActivityViewModel(server.client(), live, MutableStateFlow(true), reconcileDelay = 2_000.milliseconds)

    @Test
    fun activityPagesAndFilters() = runTest(main.dispatcher) {
        server.fixture("/api/activity", "activity.json")
        val vm = activityModel()
        vm.reload()
        assertEquals(5, vm.state.value.value!!.items.size)
        val request = server.lastRequest("GET", "/api/activity")!!
        assertEquals(listOf("7", "50", "0"), listOf(request.queryParam("days"), request.queryParam("limit"), request.queryParam("offset")))
        assertNull(request.queryParam("type"))

        suspend fun settle() {
            vm.state.first { it is LoadState.Loading }
            vm.state.first { it is LoadState.Loaded }
        }
        vm.nextPage()
        settle()
        assertEquals("50", server.lastRequest("GET", "/api/activity")!!.queryParam("offset"))
        vm.setType("task_event")
        settle()
        val filtered = server.lastRequest("GET", "/api/activity")!!
        assertEquals("task_event", filtered.queryParam("type"))
        assertEquals("0", filtered.queryParam("offset"), "a filter change goes back to the first page")
        vm.setResource("task")
        settle()
        assertEquals("task", server.lastRequest("GET", "/api/activity")!!.queryParam("resourceType"))
        vm.setDays(30)
        settle()
        assertEquals("30", server.lastRequest("GET", "/api/activity")!!.queryParam("days"))
        vm.previousPage() // already on the first page: nothing to do
        assertEquals(0, vm.filter.value.offset)
        vm.viewModelScope.cancel()
    }

    @Test
    fun activityShowsTheServerErrorAndRetries() = runTest(main.dispatcher) {
        server.on("GET", "/api/activity") { FakeResponse.fixture("activity-error.json", 500) }
        val vm = activityModel()
        vm.reload()
        val failed = assertIs<LoadState.Failed<*>>(vm.state.value)
        assertEquals(500, (failed.error as ApiError).status)
        assertEquals("Failed to fetch activity feed", failed.error.message)
        server.fixture("/api/activity", "activity.json")
        vm.reload()
        assertEquals(127, vm.state.value.value!!.total)
        vm.viewModelScope.cancel()
    }

    @Test
    fun liveActionsArePrependedThenReconciled() = runTest(main.dispatcher) {
        server.fixture("/api/activity", "activity.json")
        val live = MutableSharedFlow<ActivityNewEvent>(extraBufferCapacity = 8)
        val vm = activityModel(live)
        vm.reload()
        vm.startLive()
        testScheduler.runCurrent()
        server.clearRequests()
        live.emit(ActivityNewEvent(type = "activity:new", action = "repo.update", resourceType = "repo", resourceId = "r1", summary = "repo.update succeeded", timestamp = "2026-09-22T16:39:00.000Z"))
        testScheduler.runCurrent()
        val page = vm.state.value.value!!
        val first = page.items.first()
        assertTrue(first.isLive)
        assertEquals("repo", first.resourceType)
        assertEquals("repo.update succeeded", first.summary)
        assertEquals(128, page.total)
        assertEquals(65, page.stats.actions)
        assertEquals(0, server.count("GET", "/api/activity"), "the reload waits two seconds")
        testScheduler.advanceTimeBy(2_001)
        vm.state.first { it is LoadState.Loaded && it.value.items.none { item -> item.isLive } }
        assertEquals(1, server.count("GET", "/api/activity"))

        // A type filter other than actions, or another page, ignores live frames.
        vm.setType("task_event")
        vm.state.first { it is LoadState.Loaded && vm.filter.value.type == "task_event" }
        live.emit(ActivityNewEvent(type = "activity:new", action = "task.retry", summary = "task.retry succeeded", timestamp = "2026-09-22T16:39:30.000Z"))
        testScheduler.runCurrent()
        assertFalse(vm.state.value.value!!.items.any { it.isLive })
        vm.stopLive()
        vm.viewModelScope.cancel()
    }

    @Test
    fun theReconcileIsQuietAndAFailureKeepsTheLiveRow() = runTest(main.dispatcher) {
        server.fixture("/api/activity", "activity.json")
        val live = MutableSharedFlow<ActivityNewEvent>(extraBufferCapacity = 8)
        val vm = activityModel(live)
        vm.reload()
        vm.startLive()
        testScheduler.runCurrent()
        val seen = mutableListOf<LoadState<ActivityViewModel.Page>>()
        backgroundScope.launch { vm.state.collect { seen += it } }

        // The reload after a live row fails: the row stays and the feed isn't flagged.
        server.on("GET", "/api/activity") { FakeResponse.fixture("activity-error.json", 500) }
        server.clearRequests()
        live.emit(ActivityNewEvent(type = "activity:new", action = "repo.update", resourceType = "repo", summary = "repo.update succeeded", timestamp = "2026-09-22T16:39:00.000Z"))
        testScheduler.runCurrent()
        testScheduler.advanceTimeBy(2_001)
        server.next("GET", "/api/activity")
        repeat(30) {
            withContext(Dispatchers.IO) { Thread.sleep(10) }
            testScheduler.advanceUntilIdle()
        }
        val kept = assertIs<LoadState.Loaded<ActivityViewModel.Page>>(vm.state.value)
        assertTrue(kept.value.items.first().isLive)

        // The next one succeeds and swaps in the server's rows.
        server.fixture("/api/activity", "activity.json")
        live.emit(ActivityNewEvent(type = "activity:new", action = "repo.update", resourceType = "repo", summary = "repo.update succeeded", timestamp = "2026-09-22T16:39:30.000Z"))
        testScheduler.runCurrent()
        testScheduler.advanceTimeBy(2_001)
        vm.state.first { it is LoadState.Loaded && it.value.items.none { item -> item.isLive } }
        assertTrue(seen.none { it.isLoading }, "no dimming or spinner for either reload")
        vm.stopLive()
        vm.viewModelScope.cancel()
    }

    @Test
    fun clusterLoadsEverythingForAdmins() = runTest(main.dispatcher) {
        server.fixture("/api/cluster/overview", "cluster-overview.json")
        server.fixture("/api/cluster/pods", "cluster-pods.json")
        server.fixture("/api/cluster/health-events", "cluster-health-events.json")
        server.fixture("/api/cluster/version", "cluster-version.json")
        val vm = ClusterViewModel(server.client())
        vm.load()
        val state = vm.state.value
        assertEquals(6, state.overview?.pods?.size)
        assertEquals(2, state.repoPods.size)
        assertEquals(3, state.healthEvents.size)
        assertEquals("dev", state.version?.current)
        assertFalse(state.forbidden)
        assertFalse(state.loading)
        assertEquals("50", server.lastRequest("GET", "/api/cluster/health-events")!!.queryParam("limit"))
        vm.selectTab(ClusterViewModel.Tab.SERVICES)
        assertEquals(ClusterViewModel.Tab.SERVICES, vm.state.value.tab)
        vm.viewModelScope.cancel()
    }

    @Test
    fun clusterForNonAdminsIsForbiddenButKeepsTheVersion() = runTest(main.dispatcher) {
        server.error("GET", "/api/cluster/overview", 403, "Insufficient permissions")
        server.fixture("/api/cluster/version", "cluster-version.json")
        val vm = ClusterViewModel(server.client())
        vm.load()
        assertTrue(vm.state.value.forbidden)
        assertEquals("0.5.0", vm.state.value.version?.latest)
        assertEquals(0, server.count("GET", "/api/cluster/pods"), "no point asking for the rest")
        assertEquals(0, server.count("GET", "/api/cluster/health-events"))
        vm.viewModelScope.cancel()
    }

    @Test
    fun aClusterErrorKeepsTheLastOverview() = runTest(main.dispatcher) {
        server.fixture("/api/cluster/overview", "cluster-overview.json")
        server.json("/api/cluster/pods", """{"pods":[]}""")
        server.json("/api/cluster/health-events", """{"events":[]}""")
        server.error("GET", "/api/cluster/version", 500, "no version")
        val vm = ClusterViewModel(server.client())
        vm.load()
        server.error("GET", "/api/cluster/overview", 500, "Error: connect ECONNREFUSED")
        vm.load()
        val state = vm.state.value
        assertEquals(1, state.overview?.nodes?.size, "the poll keeps showing what it had")
        assertEquals("Error: connect ECONNREFUSED", state.error?.message)
        assertNull(state.version)
        vm.viewModelScope.cancel()
    }

    @Test
    fun podDetailLoadsItsEventsAndRestarts() = runTest(main.dispatcher) {
        val id = "765b3ac4-c6d1-44b5-ae35-bb5a831da9f4"
        server.fixture("/api/cluster/pods/$id", "cluster-pod.json")
        server.fixture("/api/cluster/health-events", "cluster-health-events.json")
        server.json("/api/cluster/pods/$id/restart", """{"ok":true}""", method = "POST")
        val vm = PodDetailViewModel(server.client(), id)
        val data = vm.state.first { it is LoadState.Loaded }.value!!
        assertEquals("optio-repo-e2e-org-e2e-repo-317e", data.pod.podName)
        assertEquals(listOf("restarted", "orphan_cleaned"), data.events.map { it.eventType }, "only this pod's events")
        vm.restart()
        assertEquals(PodDetailViewModel.Event.Restarted, vm.events.first())
        assertFalse(vm.restarting.value)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aPodThatIsGoneOrForbidden() = runTest(main.dispatcher) {
        server.error("GET", "/api/cluster/pods/p1", 403, "Insufficient permissions")
        server.error("POST", "/api/cluster/pods/p1/restart", 404, "Pod not found")
        val vm = PodDetailViewModel(server.client(), "p1")
        val failed = vm.state.first { it is LoadState.Failed }
        assertTrue((failed as LoadState.Failed<*>).error.isForbidden)
        vm.restart()
        val event = assertIs<PodDetailViewModel.Event.Failed>(vm.events.first())
        assertEquals("Pod not found", event.error.message)
        vm.viewModelScope.cancel()
    }
}
