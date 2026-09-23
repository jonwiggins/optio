package dev.optio.core.workfeed

import dev.optio.core.model.PersistentAgentStateChangedEvent
import dev.optio.core.model.PersistentAgentTurnHaltedEvent
import dev.optio.core.model.PersistentAgentTurnStartedEvent
import dev.optio.core.model.SessionCreatedEvent
import dev.optio.core.model.SessionEndedEvent
import dev.optio.core.model.TaskCreatedEvent
import dev.optio.core.model.TaskRecoveredEvent
import dev.optio.core.model.TaskStalledEvent
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WsEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.WorkView
import dev.optio.core.network.ApiClient
import java.time.Clock
import java.time.Instant
import java.util.concurrent.atomic.AtomicLong
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.conflate
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Every piece of work Optio knows about, merged from the per-kind endpoints and polled while a
 * screen holds it (iOS `WorkFeedModel`, web `use-work-feed.ts`). Backs the Work list and the
 * Overview board; each screen owns one (in its ViewModel's scope).
 *
 * - [refresh] fetches the six sources ([workFeedSources]) and re-projects them. Overlapping
 *   refreshes never go backwards: a slower, older fetch that lands after a newer one is dropped.
 * - [start] polls every [DEFAULT_INTERVAL] (starting now) and, given `/ws/events`, refreshes soon
 *   after an event that changes a row ([refreshesOn]); [stop] ends both. Idempotent.
 *
 * [load] and [clock] are seams for tests.
 */
class WorkFeedModel(
    private val load: suspend () -> WorkFeed.Sources,
    private val scope: CoroutineScope,
    private val clock: Clock = Clock.systemUTC(),
) {
    /** A model over [api]'s six endpoints. */
    constructor(api: ApiClient, scope: CoroutineScope, clock: Clock = Clock.systemUTC()) :
        this(load = { api.workFeedSources() }, scope = scope, clock = clock)

    /** What the feed screens show (iOS `WorkFeedModel`'s observable properties). */
    data class State(
        val rows: List<WorkRow> = emptyList(),
        /** True until the first refresh finishes, successful or not. */
        val loading: Boolean = true,
        /** The latest refresh's failure (every source failed); cleared by the next success. */
        val error: Throwable? = null,
        val lastRefreshed: Instant? = null,
    ) {
        /** The header / tile counts over every row. */
        val counts: WorkCounts by lazy { WorkFeed.count(rows) }

        /** Nothing to show yet: the first load is still running. */
        val placeholder: Boolean
            get() = loading && rows.isEmpty()

        /** The rows of [view] matching [query] (iOS `rows(in:query:)`). */
        fun rows(
            view: WorkView,
            query: String = "",
        ): List<WorkRow> = rows.filter { WorkFeed.inView(it, view) && WorkFeed.matches(it, query) }

        /** How many rows [view] holds, ignoring the search (the view chips' counts). */
        fun count(view: WorkView): Int = rows.count { WorkFeed.inView(it, view) }
    }

    private val _state = MutableStateFlow(State())

    /** The feed. Updated on the caller's scope. */
    val state: StateFlow<State> = _state.asStateFlow()

    private val started = AtomicLong(0)
    private val applied = AtomicLong(0)
    private var pollJob: Job? = null
    private var eventJob: Job? = null

    /** Fetches every source and re-projects the rows. Never throws (failures land in [State.error]). */
    suspend fun refresh() {
        val ticket = started.incrementAndGet()
        val result = try {
            Result.success(WorkFeed.collect(load()))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            Result.failure(e)
        }
        // A newer refresh already landed: this one is stale.
        if (!claim(ticket)) return
        val now = clock.instant()
        _state.update { current ->
            result.fold(
                onSuccess = { rows -> current.copy(rows = rows, loading = false, error = null, lastRefreshed = now) },
                onFailure = { e -> current.copy(loading = false, error = e, lastRefreshed = now) },
            )
        }
    }

    /**
     * Polls every [interval] (refreshing now) while started; with [events] (`EventHub.events`) a
     * row-changing event ([refreshesOn]) refreshes after [coalesce] — bursts collapse into one or
     * two refreshes. Idempotent: a second call while started does nothing.
     */
    fun start(
        interval: Duration = DEFAULT_INTERVAL,
        events: Flow<WsEvent>? = null,
        coalesce: Duration = EVENT_COALESCE,
    ) {
        if (pollJob?.isActive == true) return
        pollJob = scope.launch {
            while (isActive) {
                refresh()
                delay(interval)
            }
        }
        if (events != null) {
            eventJob = scope.launch {
                events.filter(::refreshesOn).conflate().collect {
                    delay(coalesce)
                    refresh()
                }
            }
        }
    }

    /** Stops polling and listening. The rows stay. */
    fun stop() {
        pollJob?.cancel()
        eventJob?.cancel()
        pollJob = null
        eventJob = null
    }

    /** True while [start]ed. */
    val isStarted: Boolean
        get() = pollJob?.isActive == true

    private fun claim(ticket: Long): Boolean {
        while (true) {
            val last = applied.get()
            if (ticket < last) return false
            if (applied.compareAndSet(last, ticket)) return true
        }
    }

    companion object {
        /** iOS `WorkFeedModel.start(every: 30)`. */
        val DEFAULT_INTERVAL: Duration = 30.seconds

        /** How long a burst of events is collected before one refresh. */
        val EVENT_COALESCE: Duration = 1.seconds

        /**
         * `/ws/events` frames that can change a feed row: the ones iOS reacts to (task state, stall
         * and recovery; persistent-agent turns and state; any `local:*` nudge), plus the ones that
         * add or end a row (`task:created`, `session:created`, `session:ended`).
         */
        fun refreshesOn(event: WsEvent): Boolean = when (event) {
            is TaskStateChangedEvent, is TaskCreatedEvent, is TaskStalledEvent, is TaskRecoveredEvent -> true
            is PersistentAgentStateChangedEvent, is PersistentAgentTurnStartedEvent, is PersistentAgentTurnHaltedEvent -> true
            is SessionCreatedEvent, is SessionEndedEvent -> true
            is WsEvent.Unknown -> event.raw["type"]?.stringValue?.startsWith("local:") == true
            else -> false
        }
    }
}
