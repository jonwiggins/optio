package dev.optio.feature.widgets.refresh

import android.content.ComponentName
import android.content.Context
import android.service.quicksettings.TileService
import androidx.datastore.preferences.core.Preferences
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.glance.appwidget.state.updateAppWidgetState
import dev.optio.feature.widgets.run.RunWidget
import dev.optio.feature.widgets.tiles.NeedsYouTileService
import dev.optio.feature.widgets.tiles.RunTargetTileService
import dev.optio.feature.widgets.work.WorkWidget
import kotlin.coroutines.cancellation.CancellationException

/**
 * Re-renders the surfaces after their data or the clock moved on. Each placed widget gets a new
 * refresh tick in its Glance state before its update, so a session that is still running
 * recomposes (and re-reads the clock) instead of only re-sending its last frame.
 */
internal object WidgetUpdates {
    suspend fun updateWork(context: Context) = tickAndUpdate(context, WorkWidget(), WorkWidget.TICK)

    suspend fun updateRun(context: Context) = tickAndUpdate(context, RunWidget(), RunWidget.TICK)

    /** True when at least one Work widget is on a home screen. */
    suspend fun hasWorkWidgets(context: Context): Boolean = GlanceAppWidgetManager(context).getGlanceIds(WorkWidget::class.java).isNotEmpty()

    /** Asks the system to re-bind the Needs-you and Run tiles (they read the cache in `onStartListening`). */
    fun requestTiles(context: Context) {
        for (service in listOf(NeedsYouTileService::class.java, RunTargetTileService::class.java)) {
            try {
                TileService.requestListeningState(context, ComponentName(context, service))
            } catch (_: RuntimeException) {
                // Not added / not allowed right now: the tile reads fresh data when it next binds.
            }
        }
    }

    private suspend fun tickAndUpdate(
        context: Context,
        widget: GlanceAppWidget,
        tick: Preferences.Key<Long>,
    ) {
        val manager = GlanceAppWidgetManager(context)
        for (id in manager.getGlanceIds(widget.javaClass)) {
            try {
                updateAppWidgetState(context, id) { it[tick] = System.currentTimeMillis() }
                widget.update(context, id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // A widget removed mid-update: nothing to render.
            }
        }
    }
}
