package dev.optio.feature.widgets.work

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.compose.runtime.getValue
import androidx.compose.runtime.produceState
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.appwidget.state.getAppWidgetState
import androidx.glance.currentState
import androidx.glance.state.PreferencesGlanceStateDefinition
import dev.optio.feature.widgets.Host
import dev.optio.feature.widgets.refresh.WidgetRefreshWorker
import java.time.Instant

/**
 * The Work widget (iOS `WorkWidget`, kind `dev.optio.ios.needs-you`): what needs you, what's
 * running, and the rest of the board, in three sizes. Configurable per server (its Server option,
 * set by [dev.optio.feature.widgets.config.WorkWidgetConfigActivity]): one paired server, or all of
 * them (the default) with a coloured server dot on each row.
 *
 * It renders `:core:glance`'s per-server cache (`GlanceLoader.cached`), recomputed whenever the
 * cache changes and on every refresh tick (a new tick re-reads the clock for waits and the stale
 * footer). Nothing here waits on the network.
 */
class WorkWidget : GlanceAppWidget() {
    // Exact, not Responsive: the content reads the real width (a large row fits its Where chip to
    // it) and picks small / medium / large from the real size.
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(
        context: Context,
        id: GlanceId,
    ) {
        val loader = Host.loader(context)
        val store = Host.store(context)
        val initial = loader.cached(getAppWidgetState(context, PreferencesGlanceStateDefinition, id)[SERVER])
        provideContent {
            val state = currentState<Preferences>()
            val server = state[SERVER]
            val entry by produceState(initial, server, state[TICK]) {
                value = loader.cached(server, Instant.now())
                store.changes.collect { value = loader.cached(server, Instant.now()) }
            }
            WorkWidgetContent(entry, WorkFamily.forSize(LocalSize.current))
        }
    }

    override suspend fun providePreview(
        context: Context,
        widgetCategory: Int,
    ) {
        provideContent { WorkWidgetContent(WidgetSamples.waiting(Instant.now()), WorkFamily.forSize(LocalSize.current)) }
    }

    companion object {
        /** The widget's Server option: a `ServerProfile.id`, or absent for every paired server. */
        val SERVER = stringPreferencesKey("work.server")

        /** Bumped by every refresh; a new value recomputes the entry (and re-reads the clock). */
        val TICK = longPreferencesKey("work.tick")
    }
}

/** Receives the Work widget's broadcasts; placing or updating one also loads fresh data. */
class WorkWidgetReceiver : GlanceAppWidgetReceiver() {
    override val glanceAppWidget: GlanceAppWidget = WorkWidget()

    override fun onUpdate(
        context: Context,
        appWidgetManager: AppWidgetManager,
        appWidgetIds: IntArray,
    ) {
        super.onUpdate(context, appWidgetManager, appWidgetIds)
        WidgetRefreshWorker.enqueue(context)
    }
}
