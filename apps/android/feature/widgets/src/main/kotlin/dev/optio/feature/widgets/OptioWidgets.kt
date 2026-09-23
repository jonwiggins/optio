package dev.optio.feature.widgets

import android.app.Application
import dev.optio.core.data.SessionStore
import dev.optio.feature.widgets.refresh.EventBridge
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * The widgets' link to the running app. Widgets, tiles and shortcuts live in the app's process
 * (no App Group needed, unlike iOS), so they share its one [SessionStore]: paired servers,
 * tokens, a client per server and the `/ws/events` hub.
 *
 * The app calls [install] once at startup; until then (and in tests) every surface behaves as
 * signed out.
 */
object OptioWidgets {
    @Volatile
    private var sessionProvider: (() -> SessionStore)? = null
    private val bridged = AtomicBoolean(false)

    /** Work that outlives a tile click or a widget broadcast (firing a target, refreshing). */
    internal val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    /**
     * Connects the widgets to the app's [session] and starts refreshing them when the app's event
     * hub reports changes (debounced). Idempotent.
     */
    fun install(
        application: Application,
        session: () -> SessionStore,
    ) {
        sessionProvider = session
        if (bridged.compareAndSet(false, true)) EventBridge.start(application, scope, session)
    }

    /** The app's session, or null before [install]. */
    internal fun session(): SessionStore? = sessionProvider?.invoke()
}
