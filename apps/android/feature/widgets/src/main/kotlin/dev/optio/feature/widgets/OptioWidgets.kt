package dev.optio.feature.widgets

import android.content.Context
import android.os.Build
import androidx.glance.appwidget.GlanceAppWidgetManager
import androidx.startup.Initializer
import dev.optio.core.glance.GlanceRefresh
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.refresh.EventBridge
import dev.optio.feature.widgets.refresh.WidgetRefresh
import dev.optio.feature.widgets.run.RunWidgetReceiver
import dev.optio.feature.widgets.work.WorkWidgetReceiver
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/**
 * The widgets' process-wide state. Widgets, tiles and shortcuts live in the app's process (no App
 * Group needed, unlike iOS) and share its one session through [Host].
 */
internal object OptioWidgets {
    /** Work that outlives a tile click or a widget broadcast (firing a target, refreshing). */
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
}

/**
 * Runs at process start, whatever started the process (the app, a widget broadcast, the background
 * check, a push): registers the widgets' [GlanceRefresh] hook, so fresh glance data re-renders
 * every widget and tile, and starts following the event hub for task rows.
 */
class WidgetsInitializer : Initializer<Unit> {
    override fun create(context: Context) {
        GlanceRefresh.register(WidgetRefresh.HOOK) { ctx, reason -> WidgetRefresh.onGlanceRefresh(ctx, reason) }
        EventBridge.start(context, OptioWidgets.scope) { Host.session() }
        OptioWidgets.scope.launch { publishPreviews(context.applicationContext) }
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()

    /**
     * API 35+ pickers show generated previews (each widget's `providePreview`, sample data, the
     * system's theme) instead of the static `previewImage`. Published once per app version: the
     * call is rate-limited.
     */
    private suspend fun publishPreviews(context: Context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return
        val version = runCatching { context.packageManager.getPackageInfo(context.packageName, 0).longVersionCode }.getOrDefault(0L)
        val flag = "previews.$version"
        val store = WidgetStore.get(context)
        if (store.flag(flag)) return
        val manager = GlanceAppWidgetManager(context)
        val published =
            runCatching {
                listOf(WorkWidgetReceiver::class, RunWidgetReceiver::class).all {
                    manager.setWidgetPreviews(it) == GlanceAppWidgetManager.SET_WIDGET_PREVIEWS_RESULT_SUCCESS
                }
            }.getOrDefault(false)
        if (published) store.setFlag(flag, true)
    }
}
