package dev.optio.feature.glance.watch

import android.app.ForegroundServiceStartNotAllowedException
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.util.Log
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import dev.optio.core.glance.GlanceHost
import dev.optio.core.glance.PushStatus
import dev.optio.feature.glance.GlanceRuntime
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.launch

/**
 * "Keep watching in the background": an opt-in foreground service that holds the app's one
 * `/ws/events` connection (`SessionStore.retainEvents()`) while Optio is closed, so the Watch and
 * the needs-you alerts update in real time on servers that cannot push (no FCM). Its notification
 * is the Watch itself when one is up, else a quiet "Keeping watch" line with a Stop button.
 */
class KeepWatching(
    private val context: Context,
    private val store: WatchStore,
    private val status: PushStatus,
) {
    /** The switch. */
    val enabled: Flow<Boolean> = store.keepWatching

    suspend fun isEnabled(): Boolean = store.keepWatching()

    /** Turns it on (starts the service; call from the foreground) or off (stops it). */
    suspend fun set(on: Boolean) {
        store.setKeepWatching(on)
        status.update { it.copy(keepWatching = on) }
        if (on) start() else stop()
    }

    /** Starts the service when the switch is on and something is paired (app launch, boot). */
    suspend fun startIfEnabled(): Boolean {
        val on = store.keepWatching()
        status.update { it.copy(keepWatching = on) }
        if (!on || GlanceHost.clients().isEmpty()) return false
        return start()
    }

    fun stop() {
        context.stopService(Intent(context, KeepWatchingService::class.java))
    }

    private fun start(): Boolean =
        try {
            ContextCompat.startForegroundService(context, Intent(context, KeepWatchingService::class.java))
            true
        } catch (e: IllegalStateException) {
            // Android 12+ refuses to start it from the background (e.g. after an app update);
            // it starts the next time the app comes to the foreground.
            if (Build.VERSION.SDK_INT >= 31 && e is ForegroundServiceStartNotAllowedException) {
                Log.i(TAG, "keep watching deferred until the app is opened")
            } else {
                Log.w(TAG, "keep watching failed to start", e)
            }
            false
        }

    private companion object {
        const val TAG = "OptioKeepWatching"
    }
}

/** The foreground service behind [KeepWatching]. */
class KeepWatchingService : Service() {
    private var hold: AutoCloseable? = null

    override fun onStartCommand(
        intent: Intent?,
        flags: Int,
        startId: Int,
    ): Int {
        val runtime = GlanceRuntime.get(this)
        val type = if (Build.VERSION.SDK_INT >= 34) ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE else 0
        ServiceCompat.startForeground(this, WatchNotifier.WATCH_ID, runtime.watch.foregroundNotification(), type)
        if (hold == null) {
            // Take the hold first, then restore the session if this is a cold process: the restore
            // starts /ws/events because a hold is taken.
            hold = GlanceHost.session?.retainEvents()
            GlanceHost.ensureStarted()
            runtime.status.update { it.copy(keepWatchingActive = true) }
            runtime.scope.launch { runtime.watch.keepWatchingChanged(true) }
        }
        return START_STICKY
    }

    override fun onDestroy() {
        hold?.close()
        hold = null
        val runtime = GlanceRuntime.get(this)
        runtime.status.update { it.copy(keepWatchingActive = false) }
        runtime.scope.launch { runtime.watch.keepWatchingChanged(false) }
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null
}

/** Re-arms "Keep watching" after a reboot or an app update. */
class KeepWatchingBootReceiver : BroadcastReceiver() {
    override fun onReceive(
        context: Context,
        intent: Intent,
    ) {
        if (intent.action != Intent.ACTION_BOOT_COMPLETED && intent.action != Intent.ACTION_MY_PACKAGE_REPLACED) return
        val runtime = GlanceRuntime.get(context)
        val pending = goAsync()
        runtime.scope.launch {
            try {
                runtime.keepWatching.startIfEnabled()
            } finally {
                pending.finish()
            }
        }
    }
}
