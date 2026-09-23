package dev.optio.feature.widgets.refresh

import android.content.Context
import dev.optio.core.data.ServerClient
import dev.optio.core.glance.GlanceLoader
import dev.optio.core.glance.GlanceRefresh
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.feature.widgets.Host
import dev.optio.feature.widgets.OptioWidgets
import java.time.Duration
import java.time.Instant
import java.util.concurrent.atomic.AtomicReference
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull

/**
 * Keeps the widgets and tiles current (iOS: the widget timeline provider plus
 * `WidgetCenter.reloadTimelines` from the app).
 *
 * The needs-you snapshots are loaded by `:core:glance` / `:feature:glance` (the Watch on
 * `/ws/events`, the 15-minute background check, pushes, notification actions), which cache them
 * per server in `GlanceStore` and then run the [GlanceRefresh] hooks; this module's hook
 * ([onGlanceRefresh]) re-renders from that cache. The widget adds what only it shows, the Repo Tasks
 * in flight, and loads everything itself when a widget is placed or updated by the launcher.
 */
internal object WidgetRefresh {
    /** The [GlanceRefresh] hook key. */
    const val HOOK = "widgets"

    /** Task rows reload at most this often from background hooks. */
    private val TASKS_EVERY: Duration = Duration.ofSeconds(60)

    private val lastTasks = AtomicReference<Instant>(Instant.EPOCH)
    private val loading = Mutex()

    /**
     * New data was cached elsewhere: re-render now; on a poll or the app returning, also reload the
     * task rows, in this module's scope so a slow server never holds up the caller (the Watch, the
     * background check), then render again.
     */
    suspend fun onGlanceRefresh(
        context: Context,
        reason: GlanceRefresh.Reason,
    ) {
        render(context)
        if (reason == GlanceRefresh.Reason.POLL || reason == GlanceRefresh.Reason.APP) {
            OptioWidgets.scope.launch { if (refreshTasks(context, Host.clients(), throttle = true)) render(context) }
        }
    }

    /**
     * Loads every paired server (snapshots and in-flight tasks) into the shared cache, then
     * re-renders (a widget was placed or configured, or the launcher asked for an update).
     */
    suspend fun loadAndRender(context: Context) {
        loading.withLock {
            Host.loader(context).load(includeTasks = true)
            lastTasks.set(Instant.now())
        }
        render(context)
    }

    /**
     * Reloads the in-flight Repo Tasks of [clients] into the cache (at most once a minute with
     * [throttle]; each server bounded by the snapshot timeout). False when it did not run.
     */
    suspend fun refreshTasks(
        context: Context,
        clients: List<ServerClient>,
        throttle: Boolean = false,
    ): Boolean {
        if (clients.isEmpty()) return false
        val now = Instant.now()
        if (throttle && Duration.between(lastTasks.get(), now) < TASKS_EVERY) return false
        lastTasks.set(now)
        val store = Host.store(context)
        coroutineScope {
            clients.map { client ->
                async {
                    withTimeoutOrNull(NeedsYouSnapshot.SERVER_TIMEOUT) { GlanceLoader.loadTasks(client.api, client.server) }
                        ?.let { store.setCachedTasks(it, client.server.id) }
                }
            }.awaitAll()
        }
        return true
    }

    /** Re-renders every surface from the cache and schedules the stale-footer flip. */
    suspend fun render(context: Context) {
        WidgetUpdates.updateWork(context)
        WidgetUpdates.updateRun(context)
        WidgetUpdates.requestTiles(context)
        if (WidgetUpdates.hasWorkWidgets(context)) WidgetTicks.scheduleStaleFlip(context)
    }
}
