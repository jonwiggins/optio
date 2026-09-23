package dev.optio.feature.widgets

import android.content.Context
import androidx.startup.Initializer
import dev.optio.core.data.SessionStore
import dev.optio.core.glance.GlanceRefresh
import dev.optio.feature.widgets.refresh.EventBridge
import dev.optio.feature.widgets.refresh.WidgetRefresh
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * The widgets' process-wide state. Widgets, tiles and shortcuts live in the app's process (no App
 * Group needed, unlike iOS) and share its one [SessionStore].
 */
object OptioWidgets {
    @Volatile
    private var sessionProvider: (() -> SessionStore)? = null

    /** Work that outlives a tile click or a widget broadcast (firing a target, refreshing). */
    internal val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /** Connects the widgets to the app's [session] (until `:core:glance`'s host provides it). */
    fun install(session: () -> SessionStore) {
        sessionProvider = session
    }

    /** The app's session, or null before it is installed. */
    internal fun session(): SessionStore? = sessionProvider?.invoke()
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
    }

    override fun dependencies(): List<Class<out Initializer<*>>> = emptyList()
}
