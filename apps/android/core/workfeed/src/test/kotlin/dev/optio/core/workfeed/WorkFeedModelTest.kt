package dev.optio.core.workfeed

import dev.optio.core.model.TaskLogEvent
import dev.optio.core.model.TaskState
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WsEvent
import dev.optio.core.navigation.WorkView
import dev.optio.core.network.ApiError
import dev.optio.core.workfeed.WorkFeed.Sources
import dev.optio.core.workfeed.WorkFeed.UnifiedRow
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

/** The screen model (iOS `WorkFeedModel`): polling, failures, ordering, live refresh. */
@OptIn(ExperimentalCoroutinesApi::class)
class WorkFeedModelTest {
    private val clock = Clock.fixed(Instant.parse("2026-09-22T16:40:00Z"), ZoneOffset.UTC)

    private fun task(
        id: String,
        state: String = "running",
    ) = UnifiedRow(type = "repo-task", id = id, title = "Task $id", state = state)

    private fun sources(vararg ids: String) = Sources(unified = ids.map { task(it) })

    private fun stateChanged() =
        TaskStateChangedEvent(
            type = "task:state_changed",
            taskId = "t1",
            fromState = TaskState.RUNNING,
            toState = TaskState.PR_OPENED,
            timestamp = "2026-09-22T16:40:00Z",
        )

    @Test
    fun startRefreshesNowThenEveryInterval() = runTest {
        var loads = 0
        val model = WorkFeedModel(load = { loads++; sources("t$loads") }, scope = backgroundScope, clock = clock)
        assertTrue(model.state.value.loading)
        assertTrue(model.state.value.placeholder)

        model.start(interval = 30.seconds)
        runCurrent()
        assertEquals(1, loads)
        with(model.state.value) {
            assertFalse(loading)
            assertEquals(listOf("task-t1"), rows.map { it.key })
            assertEquals(clock.instant(), lastRefreshed)
            assertNull(error)
        }

        model.start() // idempotent
        advanceTimeBy(29.seconds)
        runCurrent()
        assertEquals(1, loads)
        advanceTimeBy(1.seconds)
        runCurrent()
        assertEquals(2, loads)
        assertEquals(listOf("task-t2"), model.state.value.rows.map { it.key })

        model.stop()
        assertFalse(model.isStarted)
        advanceTimeBy(300.seconds)
        runCurrent()
        assertEquals(2, loads, "stopped models don't poll")
    }

    @Test
    fun aFailureKeepsTheRowsAndTheNextSuccessClearsIt() = runTest {
        var fail = false
        val model = WorkFeedModel(
            load = { if (fail) throw ApiError(0, "The server can't be reached.") else sources("t1") },
            scope = backgroundScope,
            clock = clock,
        )
        model.refresh()
        fail = true
        model.refresh()
        with(model.state.value) {
            assertIs<ApiError>(error)
            assertEquals(listOf("task-t1"), rows.map { it.key }, "the last good rows stay")
            assertFalse(loading)
        }
        fail = false
        model.refresh()
        assertNull(model.state.value.error)
    }

    @Test
    fun aFirstLoadThatFailsStopsLoadingWithTheError() = runTest {
        val model = WorkFeedModel(load = { throw ApiError(500, "Database unavailable") }, scope = backgroundScope, clock = clock)
        model.refresh()
        with(model.state.value) {
            assertFalse(loading)
            assertFalse(placeholder)
            assertTrue(rows.isEmpty())
            assertEquals("Database unavailable", error?.message)
        }
    }

    @Test
    fun anOlderFetchThatLandsLateIsDropped() = runTest {
        val first = CompletableDeferred<Sources>()
        val second = CompletableDeferred<Sources>()
        val queue = ArrayDeque(listOf(first, second))
        val model = WorkFeedModel(load = { queue.removeFirst().await() }, scope = backgroundScope, clock = clock)

        launch { model.refresh() }
        runCurrent()
        launch { model.refresh() }
        runCurrent()
        second.complete(sources("new"))
        runCurrent()
        assertEquals(listOf("task-new"), model.state.value.rows.map { it.key })
        first.complete(sources("old"))
        runCurrent()
        assertEquals(listOf("task-new"), model.state.value.rows.map { it.key }, "a stale fetch never overwrites a newer one")
    }

    @Test
    fun rowChangingEventsRefreshSoonAndBurstsCoalesce() = runTest {
        var loads = 0
        val events = MutableSharedFlow<WsEvent>(extraBufferCapacity = 16)
        val model = WorkFeedModel(load = { loads++; sources("t1") }, scope = backgroundScope, clock = clock)
        model.start(interval = 60.seconds, events = events, coalesce = 500.milliseconds)
        runCurrent()
        assertEquals(1, loads)

        // A log line changes no row.
        events.emit(TaskLogEvent(type = "task:log", taskId = "t1", stream = TaskLogEvent.Stream.STDOUT, content = "hi", timestamp = "2026-09-22T16:40:00Z"))
        advanceTimeBy(2.seconds)
        runCurrent()
        assertEquals(1, loads)

        // A burst of state changes: one refresh after the pause (plus one for what arrived meanwhile).
        repeat(5) { events.emit(stateChanged()) }
        runCurrent()
        advanceTimeBy(499.milliseconds)
        runCurrent()
        assertEquals(1, loads)
        advanceTimeBy(1.milliseconds)
        runCurrent()
        assertEquals(2, loads)
        advanceTimeBy(2.seconds)
        runCurrent()
        assertTrue(loads <= 3, "a burst costs at most two refreshes, got ${loads - 1}")

        // local:* nudges are not in the typed union; they arrive as Unknown and still count.
        val before = loads
        events.emit(WsEvent.Unknown(buildJsonObject { put("type", JsonPrimitive("local:changed")) }))
        advanceTimeBy(1.seconds)
        runCurrent()
        assertEquals(before + 1, loads)

        model.stop()
        events.emit(stateChanged())
        advanceTimeBy(5.seconds)
        runCurrent()
        assertEquals(before + 1, loads, "a stopped model ignores events")
    }

    @Test
    fun stateHelpersFilterByViewAndQuery() = runTest {
        val model = WorkFeedModel(
            load = {
                Sources(
                    unified = listOf(
                        task("a", state = "needs_attention"),
                        task("b", state = "completed"),
                        UnifiedRow(type = "standalone", id = "j", name = "Nightly notes", enabled = true),
                    ),
                )
            },
            scope = backgroundScope,
            clock = clock,
        )
        model.refresh()
        with(model.state.value) {
            assertEquals(WorkCounts(needsYou = 1, recurring = 1), counts)
            assertEquals(listOf("task-a"), rows(WorkView.ACTIVE).map { it.key })
            assertEquals(listOf("task-b"), rows(WorkView.HISTORY).map { it.key })
            assertEquals(listOf("job-j"), rows(WorkView.ALL, query = "nightly").map { it.key })
            assertEquals(3, count(WorkView.ALL))
            assertEquals(1, count(WorkView.RECURRING))
            assertEquals(0, count(WorkView.AGENTS))
        }
    }

    @Test
    fun refreshesOnTheEventsIosReactsTo() {
        assertTrue(WorkFeedModel.refreshesOn(stateChanged()))
        assertTrue(WorkFeedModel.refreshesOn(WsEvent.Unknown(buildJsonObject { put("type", JsonPrimitive("local:host_changed")) })))
        assertFalse(WorkFeedModel.refreshesOn(WsEvent.Unknown(buildJsonObject { put("type", JsonPrimitive("something:else")) })))
        assertFalse(WorkFeedModel.refreshesOn(WsEvent.Unknown(JsonPrimitive("junk"))))
    }
}
