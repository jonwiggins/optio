package dev.optio.feature.glance

import android.app.Application
import android.content.Context
import android.os.Handler
import android.os.Looper
import androidx.core.app.ActivityCompat
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.SessionStore
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.GlanceRefresh
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.NotificationPermission
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushStatus
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.WsEvent
import dev.optio.feature.glance.notifications.AlertNotifier
import dev.optio.feature.glance.notifications.NeedsYouNotifier
import dev.optio.feature.glance.notifications.NotificationHandler
import dev.optio.feature.glance.notifications.NotifiedStore
import dev.optio.feature.glance.notifications.OptioChannel
import dev.optio.feature.glance.push.FirebaseTokenSource
import dev.optio.feature.glance.push.PushMessageHandler
import dev.optio.feature.glance.push.PushRegistrar
import dev.optio.feature.glance.refresh.GlanceWork
import dev.optio.feature.glance.watch.KeepWatching
import dev.optio.feature.glance.watch.WatchHost
import dev.optio.feature.glance.watch.WatchManager
import dev.optio.feature.glance.watch.WatchNotifier
import dev.optio.feature.glance.watch.WatchStore
import java.util.concurrent.atomic.AtomicBoolean
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch

/**
 * The glanceable surfaces' entry point for the app. Call once from `Application.onCreate`:
 *
 * ```
 * OptioGlance.install(this, session = { graph.session }, start = { graph.start() })
 * ```
 *
 * It installs [GlanceHost] (so widgets, tiles, workers and receivers reach the session), the
 * notification channels, foreground tracking, and starts the Watch, push registration, the
 * 15-minute background check and — when switched on — "Keep watching".
 */
object OptioGlance {
    fun install(
        application: Application,
        session: () -> SessionStore,
        start: () -> Unit = {},
    ) {
        GlanceHost.install(session, start)
        AppForeground.install(application)
        OptioChannel.createAll(application)
        GlanceRuntime.get(application).start()
    }
}

/**
 * The process's glance machinery, one instance (created by [OptioGlance.install], or on first use
 * by a component the system started).
 */
class GlanceRuntime private constructor(
    val context: Context,
) {
    val scope: CoroutineScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    val status: PushStatus = PushStatus.get(context)
    val sources: WatchSources = WatchSources.get(context)
    val glanceStore: GlanceStore = GlanceStore.get(context)
    val watchStore: WatchStore = WatchStore.get(context)
    val alerts = AlertNotifier(context)
    val notifier = WatchNotifier(context)
    val host: WatchHost = SessionWatchHost(scope)

    val needsYou = NeedsYouNotifier(alerts, NotifiedStore.get(context), status::isPushCovered)

    val watch =
        WatchManager(
            scope = scope,
            host = host,
            sources = sources,
            glanceStore = glanceStore,
            store = watchStore,
            notifier = notifier,
            needsYou = needsYou,
            foreground = { AppForeground.isForeground },
            onNeedsYouWhileOpen = { PermissionPrompt.maybeAsk(context, status) },
            refreshSurfaces = { reason -> GlanceRefresh.refreshAll(context, reason) },
        )

    val handler =
        NotificationHandler(
            clients = { GlanceHost.clients() },
            resolve = { id -> GlanceHost.session?.resolveClient(id) },
            store = glanceStore,
            sources = sources,
            alerts = alerts,
            afterAction = {
                watch.reconcileSoon(GlanceRefresh.Reason.ACTION)
                GlanceRefresh.refreshAll(context, GlanceRefresh.Reason.ACTION)
            },
        )

    val registrar = PushRegistrar(context, scope, status, FirebaseTokenSource(context), { GlanceHost.clients() }, host.servers)

    val push =
        PushMessageHandler(
            alerts = alerts,
            watch = watch,
            scope = scope,
            resolveServer = { kind, id -> handler.resolveServerId(kind, id) },
            refreshSurfaces = { reason -> GlanceRefresh.refreshAll(context, reason) },
        )

    val keepWatching = KeepWatching(context, watchStore, status)

    private val started = AtomicBoolean(false)

    /** Starts the Watch, push registration, the background check and keep-watching. Idempotent. */
    fun start() {
        if (!started.compareAndSet(false, true)) return
        status.refreshPermission(context)
        watch.start()
        registrar.start()
        GlanceWork.schedule(context)
        scope.launch { keepWatching.startIfEnabled() }
        // Back in the foreground: check at once, and re-arm keep-watching if Android refused it earlier.
        scope.launch {
            AppForeground.inForeground.drop(1).filter { it }.collect {
                watch.reconcileSoon(GlanceRefresh.Reason.APP)
                keepWatching.startIfEnabled()
            }
        }
        // Signed out of every server: stop keep-watching and the background check.
        scope.launch {
            host.servers.map { it.isEmpty() }.distinctUntilChanged().drop(1).collect { empty ->
                if (empty) {
                    keepWatching.stop()
                    GlanceWork.cancel(context)
                    registrar.unregisterAll()
                } else {
                    GlanceWork.schedule(context)
                }
            }
        }
    }

    companion object {
        @Volatile
        private var instance: GlanceRuntime? = null

        fun get(context: Context): GlanceRuntime =
            instance ?: synchronized(this) {
                instance ?: GlanceRuntime(context.applicationContext).also { instance = it }
            }
    }
}

/** [WatchHost] over the app's session: stored profiles (no restore needed) and the live events. */
internal class SessionWatchHost(
    scope: CoroutineScope,
) : WatchHost {
    override suspend fun clients() = GlanceHost.clients()

    // The stored profiles, not SessionStore.servers: a process started by a push or the
    // background check never restores the session, but must still know the servers.
    override val servers: StateFlow<List<ServerProfile>> =
        (GlanceHost.session?.registry?.profiles ?: flowOf(emptyList()))
            .stateIn(scope, SharingStarted.Eagerly, emptyList())

    override val events: Flow<WsEvent>
        get() = GlanceHost.session?.events?.events ?: emptyFlow()

    override val activeServerId: String?
        get() = GlanceHost.session?.activeServer?.value?.id
}

/**
 * The notification permission prompt (iOS: never on first launch; the first time something needs
 * you while the app is open, or from Settings). Android 13+ only; shown once.
 */
object PermissionPrompt {
    private const val REQUEST_CODE = 0x0971

    fun maybeAsk(
        context: Context,
        status: PushStatus,
    ) {
        if (!NotificationPermission.isRuntime || AppForeground.suppressPermissionPrompt) return
        if (status.state.value.permission != NotificationPermissionState.NOT_DETERMINED || status.prompted(context)) return
        val activity = AppForeground.resumedActivity ?: return
        Handler(Looper.getMainLooper()).post {
            if (activity.isFinishing || status.prompted(context)) return@post
            status.markPrompted(context)
            ActivityCompat.requestPermissions(activity, arrayOf(NotificationPermission.PERMISSION), REQUEST_CODE)
        }
    }
}
