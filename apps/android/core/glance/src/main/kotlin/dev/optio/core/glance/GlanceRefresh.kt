package dev.optio.core.glance

import android.content.Context
import android.util.Log
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException

/**
 * Where fresh glance data is announced (iOS `WidgetCenter.reloadAllTimelines()` +
 * `AppRefresh.handlers`). `:feature:glance` calls [refreshAll] after it has cached new snapshots
 * in [GlanceStore] (the 15-minute background check, a push, the Watch while the app runs, a
 * notification action); surfaces that render from the cache (widgets, Quick Settings tiles)
 * register a hook and re-render:
 *
 * ```
 * GlanceRefresh.register("widgets") { context, reason -> WorkWidget().updateAll(context) }
 * ```
 *
 * Hooks run one after another on the caller's coroutine; one failing never stops the others.
 * Registration is process-wide: register once at process start (an `androidx.startup`
 * Initializer or the Application).
 */
object GlanceRefresh {
    /** Why the data changed. */
    enum class Reason {
        /** The periodic background check (WorkManager). */
        POLL,

        /** A push (FCM alert or Watch frame). */
        PUSH,

        /** `/ws/events` while the app runs or "Keep watching" holds it. */
        EVENTS,

        /** The app came to the foreground or the user refreshed. */
        APP,

        /** A notification / widget action changed something (Later, Reply, Resume, …). */
        ACTION,
    }

    private val hooks = ConcurrentHashMap<String, suspend (Context, Reason) -> Unit>()

    /** Registers [hook] under [key] (a later registration with the same key replaces it). */
    fun register(
        key: String,
        hook: suspend (Context, Reason) -> Unit,
    ) {
        hooks[key] = hook
    }

    fun unregister(key: String) {
        hooks.remove(key)
    }

    /** The registered keys (diagnostics). */
    val keys: Set<String>
        get() = hooks.keys.toSet()

    /** Runs every hook. */
    suspend fun refreshAll(
        context: Context,
        reason: Reason,
    ) {
        for ((key, hook) in hooks.entries.toList()) {
            try {
                hook(context.applicationContext, reason)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w("GlanceRefresh", "refresh hook $key failed", e)
            }
        }
    }
}
