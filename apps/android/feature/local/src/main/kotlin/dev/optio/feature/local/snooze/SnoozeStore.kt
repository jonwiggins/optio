package dev.optio.feature.local.snooze

import android.content.Context
import android.content.SharedPreferences
import dev.optio.core.network.ApiClient
import dev.optio.feature.local.api.snoozeLocalTerminal
import dev.optio.feature.local.api.unsnoozeLocalTerminal
import java.time.Clock
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException

/**
 * "Later" for a needs-you terminal: a port of iOS `Core/Notifications/Snooze.swift`. The server's
 * snooze is the source of truth (`POST /api/local/terminals/:id/snooze`, `local_terminals.snoozedUntil`,
 * read by the Watch, widgets and push); when the server is unreachable or predates the route, a local
 * window on this phone keeps the in-app queue and the widgets agreeing.
 *
 * Local windows live in the `optio_snooze` shared preferences as `optio.snoozed.<terminalId>` =
 * expiry in epoch milliseconds (iOS: the same key, a `Date`, in the App Group defaults), so the
 * glance surfaces in this process can read them too.
 */
class SnoozeStore(
    private val prefs: SnoozePrefs,
    private val clock: Clock = Clock.systemUTC(),
) {
    /** What the store keeps; [SharedPreferencesSnoozePrefs] in the app, a map in tests. */
    interface SnoozePrefs {
        fun get(key: String): Long?

        fun put(key: String, value: Long)

        fun remove(key: String)
    }

    /** The local window for [id], when one is open. */
    fun snoozedUntil(id: String): Instant? {
        val until = prefs.get(key(id))?.let(Instant::ofEpochMilli) ?: return null
        return until.takeIf { it.isAfter(clock.instant()) }
    }

    fun isSnoozed(id: String): Boolean = snoozedUntil(id) != null

    fun snoozeLocally(
        id: String,
        minutes: Int = DEFAULT_MINUTES,
    ): Instant {
        val until = clock.instant().plus(Duration.ofMinutes(minutes.toLong()))
        prefs.put(key(id), until.toEpochMilli())
        return until
    }

    fun clearLocal(id: String) = prefs.remove(key(id))

    /**
     * Server first, local fallback. Never throws: "Later" must always succeed from a banner. Returns
     * where the snooze landed.
     */
    suspend fun snooze(
        id: String,
        api: ApiClient?,
        minutes: Int = DEFAULT_MINUTES,
    ): Outcome {
        if (api != null && api.isConfigured) {
            try {
                api.snoozeLocalTerminal(id, minutes)
                clearLocal(id)
                return Outcome.SERVER
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Fall through to the local window.
            }
        }
        snoozeLocally(id, minutes)
        return Outcome.LOCAL
    }

    /** Back into the queue now: the server's snooze and this phone's window both go. */
    suspend fun unsnooze(
        id: String,
        api: ApiClient?,
    ) {
        clearLocal(id)
        if (api != null && api.isConfigured) {
            try {
                api.unsnoozeLocalTerminal(id)
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // Nothing to undo on a server that never had it.
            }
        }
    }

    enum class Outcome { SERVER, LOCAL }

    companion object {
        const val DEFAULT_MINUTES: Int = 15
        const val PREFS_NAME: String = "optio_snooze"

        fun key(id: String): String = "optio.snoozed.$id"

        /** The store over this app's `optio_snooze` preferences. */
        fun create(context: Context): SnoozeStore =
            SnoozeStore(SharedPreferencesSnoozePrefs(context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)))
    }
}

class SharedPreferencesSnoozePrefs(private val prefs: SharedPreferences) : SnoozeStore.SnoozePrefs {
    override fun get(key: String): Long? = if (prefs.contains(key)) prefs.getLong(key, 0L) else null

    override fun put(key: String, value: Long) {
        prefs.edit().putLong(key, value).apply()
    }

    override fun remove(key: String) {
        prefs.edit().remove(key).apply()
    }
}

/** An in-memory store (tests, previews). */
class InMemorySnoozePrefs : SnoozeStore.SnoozePrefs {
    private val values = HashMap<String, Long>()

    override fun get(key: String): Long? = values[key]

    override fun put(key: String, value: Long) {
        values[key] = value
    }

    override fun remove(key: String) {
        values.remove(key)
    }
}
