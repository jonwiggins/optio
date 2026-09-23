package dev.optio.feature.widgets.refresh

import android.content.Context
import dev.optio.core.data.SessionStore
import dev.optio.core.model.PersistentAgentStateChangedEvent
import dev.optio.core.model.PersistentAgentTurnHaltedEvent
import dev.optio.core.model.PersistentAgentTurnStartedEvent
import dev.optio.core.model.PrReviewStateChangedEvent
import dev.optio.core.model.SessionCreatedEvent
import dev.optio.core.model.SessionEndedEvent
import dev.optio.core.model.TaskCreatedEvent
import dev.optio.core.model.TaskRecoveredEvent
import dev.optio.core.model.TaskStalledEvent
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WorkflowRunStateChangedEvent
import dev.optio.core.model.WsEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.tiles.TileFlags
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch

/**
 * Keeps the widgets current while the app runs (iOS: `EventHub` → `WidgetCenter.reloadTimelines`,
 * coalesced to at most one per 10 s): every board change on the app's `/ws/events` socket (a task
 * or run changing state, an agent turn, a Local terminal changing) schedules one refresh after a
 * short quiet period, and refreshes are at least [MIN_INTERVAL] apart. Log lines, messages and
 * comments never refresh. Nothing is fetched when no Work widget or Needs-you tile is placed.
 */
internal object EventBridge {
    /** Let a burst of events settle before fetching. */
    val DEBOUNCE: Duration = 2.seconds

    /** At most one refresh per this long. */
    val MIN_INTERVAL: Duration = 10.seconds

    fun start(
        context: Context,
        scope: CoroutineScope,
        session: () -> SessionStore,
    ) {
        val app = context.applicationContext
        val signals = Channel<Unit>(Channel.CONFLATED)
        scope.launch {
            session().events.events.filter(::isBoardEvent).collect { signals.trySend(Unit) }
        }
        scope.launch {
            for (signal in signals) {
                delay(DEBOUNCE)
                val wanted = WidgetUpdates.hasWorkWidgets(app) || TileFlags.needsYouAdded(WidgetStore.get(app).snapshot())
                if (wanted) runCatching { WidgetRefresher.refresh(app, session()) }
                delay(MIN_INTERVAL - DEBOUNCE)
            }
        }
    }

    /** Events that can change what the board shows. */
    fun isBoardEvent(event: WsEvent): Boolean =
        when (event) {
            is TaskStateChangedEvent, is TaskCreatedEvent, is TaskStalledEvent, is TaskRecoveredEvent,
            is WorkflowRunStateChangedEvent, is PrReviewStateChangedEvent,
            is PersistentAgentStateChangedEvent, is PersistentAgentTurnStartedEvent, is PersistentAgentTurnHaltedEvent,
            is SessionCreatedEvent, is SessionEndedEvent,
            -> true
            // `local:changed` is not in the TS union yet: it arrives as Unknown.
            is WsEvent.Unknown -> event.raw["type"]?.stringValue == "local:changed"
            else -> false
        }
}
