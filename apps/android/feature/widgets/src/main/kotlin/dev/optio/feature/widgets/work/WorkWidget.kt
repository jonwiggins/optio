package dev.optio.feature.widgets.work

import android.appwidget.AppWidgetManager
import android.content.Context
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.glance.GlanceId
import androidx.glance.LocalSize
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.GlanceAppWidgetReceiver
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.provideContent
import androidx.glance.currentState
import dev.optio.core.data.ServerProfile
import dev.optio.feature.widgets.OptioWidgets
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.refresh.WidgetRefreshWorker
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.combine
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map

/**
 * The Work widget (iOS `WorkWidget`, kind `dev.optio.ios.needs-you`): what needs you, what's
 * running, and the rest of the board, in three sizes. Configurable per server (its Server option,
 * set by [dev.optio.feature.widgets.config.WorkWidgetConfigActivity]): one paired server, or all of
 * them (the default) with a coloured server dot on each row.
 *
 * The content reads the refresher's per-server cache as a flow, so a refresh recomposes a running
 * session, and the widget's own Glance state (its Server option and a refresh tick that re-reads
 * the clock for waits and staleness).
 */
class WorkWidget : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Responsive(WorkFamily.entries.map { it.breakpoint }.toSet())

    override suspend fun provideGlance(
        context: Context,
        id: GlanceId,
    ) {
        val store = WidgetStore.get(context)
        val registry = OptioWidgets.session()?.registry
        val servers: Flow<List<ServerProfile>> =
            registry?.let { combine(it.profiles, it.activeIdChanges) { _, _ -> }.map { _ -> it.configured() } } ?: flowOf(emptyList())
        val initialServers = registry?.configured().orEmpty()
        val initialPrefs = store.snapshot()
        provideContent {
            val state = currentState<Preferences>()
            val paired by servers.collectAsState(initialServers)
            val cache by store.data.collectAsState(initialPrefs)
            // A refresh bumps TICK, which changes `state` and recomposes this with a fresh clock
            // (waits, the stale footer).
            val now = Instant.now()
            WorkWidgetContent(WorkEntryBuilder.build(paired, cache, state[SERVER], now), WorkFamily.forSize(LocalSize.current))
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

        /** Bumped by every refresh; reading it makes the content recompose (and re-read the clock). */
        val TICK = longPreferencesKey("work.tick")
    }
}

/** Receives the Work widget's broadcasts; placing or updating one also refreshes the data. */
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
