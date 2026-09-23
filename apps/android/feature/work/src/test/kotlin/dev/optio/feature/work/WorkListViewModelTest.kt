package dev.optio.feature.work

import dev.optio.core.model.SessionEndedEvent
import dev.optio.core.model.WsEvent
import dev.optio.core.navigation.WorkView
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedEndpoints
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withTimeout
import org.junit.Rule

/** Work › All's state: the feed over the six endpoints, views, search, refresh, live updates. */
@OptIn(ExperimentalCoroutinesApi::class)
class WorkListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule(UnconfinedTestDispatcher())

    private val server = FakeOptioServer().start()

    @AfterTest
    fun tearDown() = server.close()

    @Test
    fun loadsTheSeedFromTheSixEndpoints() = runBlocking {
        WorkSeed.serve(server)
        val vm = WorkListViewModel(server.client(), events = null)
        vm.refresh()
        val state = withTimeout(10_000) { vm.state.first { !it.loading } }

        assertNull(state.error)
        assertEquals(WorkSeed.rows, state.rows)
        assertEquals(9, state.count(WorkView.ACTIVE))
        assertEquals(4, state.count(WorkView.RECURRING))
        assertEquals(2, state.count(WorkView.AGENTS))
        assertEquals(7, state.count(WorkView.HISTORY))
        assertEquals(21, state.count(WorkView.ALL))
        withTimeout(10_000) { vm.refreshing.first { !it } }
        assertEquals(6, server.requests.size, "one request per endpoint")
        assertEquals("all", server.lastRequest("GET", WorkFeedEndpoints.UNIFIED)?.queryParam("type"))
    }

    @Test
    fun aDeadServerShowsTheErrorAndRetryRecovers() = runBlocking {
        server.on("GET", "/api/*") { dev.optio.core.testing.FakeResponse.error(502, "Bad gateway") }
        val vm = WorkListViewModel(server.client(), events = null)
        vm.refresh()
        val failed = withTimeout(10_000) { vm.state.first { !it.loading } }
        assertNotNull(failed.error)
        assertTrue(failed.rows.isEmpty())

        server.resetRoutes()
        WorkSeed.serve(server)
        withTimeout(10_000) { vm.refreshing.first { !it } }
        vm.refresh()
        val recovered = withTimeout(10_000) { vm.state.first { it.error == null && it.rows.isNotEmpty() } }
        assertEquals(WorkSeed.rows.size, recovered.rows.size)
    }

    @Test
    fun viewsSearchAndTheSearchField() = runTest {
        val vm = WorkListViewModel(load = { WorkSeed.sources }, initialView = WorkView.RECURRING)
        assertEquals(WorkView.RECURRING, vm.view.value)
        vm.select(WorkView.HISTORY)
        assertEquals(WorkView.HISTORY, vm.view.value)

        assertFalse(vm.searching.value)
        vm.toggleSearch()
        assertTrue(vm.searching.value)
        vm.setQuery("coil")
        vm.refresh()
        runCurrent()
        val state = vm.state.value
        assertEquals(listOf("Migrate the image cache to Coil 3"), state.rows(WorkView.ALL, vm.query.value).map { it.name })
        vm.toggleSearch()
        assertFalse(vm.searching.value)
        assertEquals("", vm.query.value, "closing the search clears it")
    }

    @Test
    fun startPollsAndFollowsEventsUntilStopped() = runTest(main.dispatcher) {
        var loads = 0
        val events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 8)
        val vm = WorkListViewModel(load = { loads++; WorkSeed.sources }, events = events)
        vm.start()
        runCurrent()
        assertEquals(1, loads)

        events.emit(SessionEndedEvent(type = "session:ended", sessionId = "s1", timestamp = "2026-09-23T00:52:00Z"))
        advanceTimeBy(1.seconds)
        runCurrent()
        assertEquals(2, loads, "a row-changing event refreshes soon")

        advanceTimeBy(30.seconds)
        runCurrent()
        assertEquals(3, loads, "and the poll keeps going")

        vm.stop()
        events.emit(SessionEndedEvent(type = "session:ended", sessionId = "s1", timestamp = "2026-09-23T00:52:00Z"))
        advanceTimeBy(60.seconds)
        runCurrent()
        assertEquals(3, loads, "stopped: no polls, no event refreshes")
    }

    @Test
    fun pullToRefreshShowsTheSpinnerOnlyWhileItRuns() = runTest(main.dispatcher) {
        val gate = kotlinx.coroutines.CompletableDeferred<WorkFeed.Sources>()
        val vm = WorkListViewModel(load = { gate.await() })
        vm.refresh()
        runCurrent()
        assertTrue(vm.refreshing.value)
        vm.refresh() // a second pull while one runs does nothing
        gate.complete(WorkSeed.sources)
        runCurrent()
        assertFalse(vm.refreshing.value)
        assertEquals(WorkSeed.rows, vm.state.value.rows)
    }
}
