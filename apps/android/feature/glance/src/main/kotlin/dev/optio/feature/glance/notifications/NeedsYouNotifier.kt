package dev.optio.feature.glance.notifications

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.model.WatchItemKind
import java.time.Instant
import kotlinx.coroutines.flow.first

/**
 * The on-device baseline's alerts (PLAN §8): when a check of a server (the 15-minute background
 * work, the Watch while the app runs, "Keep watching") finds needs-you items this phone has not
 * alerted about, it posts them — the same copy, category and deep link the server's push would
 * carry. Servers that push to this device (FCM registered and configured) are skipped: they send
 * their own alerts.
 *
 * "Seen" is per server and per episode: an item's key stays in the set while it keeps needing you
 * and is dropped when it leaves, so the next time it needs you it alerts again. Snoozed items count
 * as seen ("Later" never re-alerts when the window closes, like the server).
 */
class NeedsYouNotifier(
    private val alerts: AlertNotifier,
    private val store: NotifiedStore,
    /** True when [serverId] pushes its own alerts to this device. */
    private val pushCovered: (serverId: String) -> Boolean = { false },
) {
    /**
     * Alerts for the needs-you items of [serverId]'s fresh [snapshot] not alerted before, and
     * remembers the current set. Returns what it posted (or would have posted when
     * [post] is false or the server pushes).
     */
    suspend fun notifyNew(
        serverId: String,
        snapshot: NeedsYouSnapshot,
        now: Instant = Instant.now(),
        post: Boolean = true,
    ): List<AlertSpec> {
        val current = snapshot.needsYou.associateBy(::key)
        val seen = store.seen(serverId)
        store.setSeen(serverId, current.keys)
        val fresh = current.filterKeys { it !in seen }.values.filterNot { it.isSnoozed(now) }.sortedBy { it.since }
        if (fresh.isEmpty() || pushCovered(serverId)) return emptyList()
        // Sound only when the queue was empty (the server's rule), and once per batch.
        val queueWasEmpty = current.keys.none { it in seen }
        val specs = fresh.mapIndexed { index, item -> spec(item, serverId, audible = queueWasEmpty && index == 0) }
        if (post) specs.forEach(alerts::post)
        return specs
    }

    /** Forgets a server (it was unpaired). */
    suspend fun forget(serverId: String) = store.forget(serverId)

    companion object {
        /** One needs-you episode of an item: its kind and id (and a task's state, which alerts again on change). */
        fun key(item: GlanceItem): String =
            when (item.kind) {
                WatchItemKind.TASK -> "task|${item.id}|${item.state}"
                else -> "${item.kind.raw}|${item.id}"
            }

        /** The alert the server would send for [item] (glance-service.ts copy). */
        fun spec(
            item: GlanceItem,
            serverId: String?,
            audible: Boolean = true,
        ): AlertSpec =
            when (item.kind) {
                WatchItemKind.TASK -> {
                    val failed = item.state == "failed"
                    val repo = item.whereValue.detail ?: item.mono
                    AlertSpec(
                        category = NotificationCategory.TASK_ATTENTION,
                        title = if (failed) "Task failed" else "Task needs you",
                        body = if (failed && item.reason != null) "${item.title} — ${item.reason}" else "${item.title} — $repo",
                        url = item.link,
                        kind = "task",
                        id = item.id,
                        threadId = "task-${item.id}",
                        audible = audible,
                        timeSensitive = true,
                        prUrl = item.prUrl,
                        collapseId = "task-${item.id}",
                        serverId = serverId,
                    )
                }
                WatchItemKind.AGENT -> {
                    val why = item.reason?.takeUnless { it.startsWith("Turn failed") }
                    AlertSpec(
                        category = NotificationCategory.AGENT_FAILED,
                        title = "${item.title} stopped",
                        body = if (why != null) "Too many failed turns — $why" else "Too many failed turns — resume when ready",
                        url = item.link,
                        kind = "agent",
                        id = item.id,
                        threadId = "agent-${item.id}",
                        audible = audible,
                        timeSensitive = true,
                        collapseId = "agent-${item.id}",
                        serverId = serverId,
                    )
                }
                else -> {
                    val reason = item.reason ?: "Needs you"
                    AlertSpec(
                        category = NotificationCategory.LOCAL_NEEDS_YOU,
                        title = "Needs you · ${item.mono}",
                        subtitle = item.title,
                        body = item.preview?.let { "$reason · $it" } ?: reason,
                        url = item.link,
                        kind = "local",
                        id = item.id,
                        threadId = item.id,
                        audible = audible,
                        timeSensitive = true,
                        collapseId = "local-${item.id}",
                        serverId = serverId,
                    )
                }
            }
    }
}

/** The needs-you keys each server was last seen with ([NeedsYouNotifier]). */
class NotifiedStore(
    private val store: DataStore<Preferences>,
) {
    suspend fun seen(serverId: String): Set<String> = store.data.first()[key(serverId)].orEmpty()

    suspend fun setSeen(
        serverId: String,
        keys: Set<String>,
    ) {
        store.edit { it[key(serverId)] = keys }
    }

    suspend fun forget(serverId: String) {
        store.edit { it.remove(key(serverId)) }
    }

    private fun key(serverId: String) = stringSetPreferencesKey("optio.notified.$serverId")

    companion object {
        @Volatile
        private var shared: NotifiedStore? = null

        fun get(context: Context): NotifiedStore =
            shared ?: synchronized(this) {
                shared ?: NotifiedStore(
                    PreferenceDataStoreFactory.create { context.applicationContext.preferencesDataStoreFile("optio_glance_notified") },
                ).also { shared = it }
            }

        fun inMemory(): NotifiedStore = NotifiedStore(InMemoryPreferences())
    }
}
