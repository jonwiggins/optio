package dev.optio.feature.widgets.refresh

import android.content.Context
import dev.optio.core.data.SessionStore
import dev.optio.core.model.PrReviewStateChangedEvent
import dev.optio.core.model.TaskCreatedEvent
import dev.optio.core.model.TaskRecoveredEvent
import dev.optio.core.model.TaskStalledEvent
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WorkflowRunStateChangedEvent
import dev.optio.core.model.WsEvent
import dev.optio.feature.widgets.run.attempt
import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/**
 * The Work widget's task rows while the app runs (iOS: `EventHub` → `WidgetCenter.reloadTimelines`,
 * coalesced to at most one per 10 s). Needs-you snapshots already follow `/ws/events` through the
 * Watch (`:feature:glance`), which re-renders the widgets via `GlanceRefresh`; this adds the Repo
 * Tasks in flight: a task or run changing state on the active server reloads that server's task
 * rows after a short quiet period, at most once per [MIN_INTERVAL], when a Work widget is placed.
 */
internal object EventBridge {
    /** Let a burst of events settle before fetching. */
    val DEBOUNCE: Duration = 2.seconds

    /** At most one refresh per this long. */
    val MIN_INTERVAL: Duration = 10.seconds

    /**
     * Starts following [session]'s event hub once the app has installed it (the process may start
     * for a widget broadcast or a worker before the application wires the session).
     */
    fun start(
        context: Context,
        scope: CoroutineScope,
        session: () -> SessionStore?,
    ) {
        val app = context.applicationContext
        val signals = Channel<Unit>(Channel.CONFLATED)
        scope.launch {
            val live = awaitSession(session) ?: return@launch
            live.events.events.filter(::isTaskEvent).collect { signals.trySend(Unit) }
        }
        scope.launch {
            for (signal in signals) {
                delay(DEBOUNCE)
                val live = session()
                if (live != null && WidgetUpdates.hasWorkWidgets(app)) {
                    attempt {
                        val active = live.activeServer.value?.id
                        val client = live.resolveClient(active)
                        if (client != null) {
                            WidgetRefresh.refreshTasks(app, listOf(client))
                            WidgetUpdates.updateWork(app)
                        }
                    }
                }
                delay(MIN_INTERVAL - DEBOUNCE)
            }
        }
    }

    /** Events that change which Repo Tasks are in flight or how they read. */
    fun isTaskEvent(event: WsEvent): Boolean =
        when (event) {
            is TaskStateChangedEvent, is TaskCreatedEvent, is TaskStalledEvent, is TaskRecoveredEvent,
            is WorkflowRunStateChangedEvent, is PrReviewStateChangedEvent,
            -> true
            else -> false
        }

    /** The session once installed; gives up after a minute (nothing installed it: tests). */
    private suspend fun awaitSession(session: () -> SessionStore?): SessionStore? {
        repeat(600) {
            session()?.let { return it }
            delay(100.milliseconds)
        }
        return null
    }
}
