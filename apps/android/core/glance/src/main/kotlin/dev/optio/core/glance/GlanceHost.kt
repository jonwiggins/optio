package dev.optio.core.glance

import android.content.Context
import dev.optio.core.data.ServerClient
import dev.optio.core.data.SessionStore

/**
 * How code the system starts on its own — widgets, Quick Settings tiles, WorkManager workers,
 * notification receivers, the FCM service — reaches the app's one [SessionStore] (iOS reached the
 * shared credentials through the App Group; everything here shares the app process).
 *
 * The app installs it once from `Application.onCreate` (through `OptioGlance.install` in
 * `:feature:glance`), before any of those components run:
 *
 * ```
 * val clients = GlanceHost.clients()                 // every paired server, active first
 * val entry = GlanceHost.loader(context).cached()    // last good data, no network
 * ```
 */
object GlanceHost {
    @Volatile
    private var sessionProvider: (() -> SessionStore)? = null

    @Volatile
    private var starter: (() -> Unit)? = null

    /**
     * Installs the session source. [start] restores the session once per process (the app's
     * `AppGraph.start()`); components that need the live session (the event socket) call
     * [ensureStarted] — plain loads only need [clients], which read the stored servers directly.
     */
    fun install(
        session: () -> SessionStore,
        start: () -> Unit = {},
    ) {
        sessionProvider = session
        starter = start
    }

    /** Whether the app installed a session source (false in bare unit tests). */
    val isInstalled: Boolean
        get() = sessionProvider != null

    /** The app's session, or null before [install]. */
    val session: SessionStore?
        get() = sessionProvider?.invoke()

    /** Restores the session if nothing has yet (idempotent; the app guards it). */
    fun ensureStarted() {
        starter?.invoke()
    }

    /** Every paired server with a client, active first; empty when signed out or not installed. */
    suspend fun clients(): List<ServerClient> = session?.clients().orEmpty()

    /** A [GlanceLoader] over the process's [GlanceStore] and the paired servers. */
    fun loader(context: Context): GlanceLoader = GlanceLoader(GlanceStore.get(context), ::clients)
}

/**
 * The object the user is looking at right now (iOS `NotificationHandler.currentSubject`, set by
 * detail screens through `.notificationSubject(kind:id:)`): alerts about it are posted silently
 * while it is on screen. `kind` is the push `kind`: `local`, `task`, `agent`.
 *
 * ```
 * DisposableEffect(terminalId) {
 *     NotificationSubject.set("local", terminalId)
 *     onDispose { NotificationSubject.clear("local", terminalId) }
 * }
 * ```
 */
object NotificationSubject {
    @Volatile
    var current: Pair<String, String>? = null
        private set

    fun set(
        kind: String,
        id: String,
    ) {
        current = kind to id
    }

    /** Clears the subject if it is still [kind] / [id]. */
    fun clear(
        kind: String,
        id: String,
    ) {
        if (current == kind to id) current = null
    }

    /** True while [kind] / [id] is on screen. */
    fun isViewing(
        kind: String?,
        id: String?,
    ): Boolean = kind != null && id != null && current == kind to id
}
