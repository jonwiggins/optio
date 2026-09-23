package dev.optio.core.glance

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.core.stringSetPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.optio.core.data.InMemoryPreferences
import java.time.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.hours
import kotlin.time.toJavaDuration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.serialization.builtins.MapSerializer
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.Json

/**
 * What the user asked the Watch to include besides Local terminals (port of iOS
 * `Core/LiveActivity/WatchSources.swift`):
 *
 * - **Followed tasks** — Repo Tasks the user follows ("Follow" in task detail). A followed task
 *   joins the Watch as an item; it never gets its own notification surface. The Watch unfollows
 *   it automatically when it reaches `completed` / `cancelled` / a final `failed`.
 * - **Recent agent sends** — persistent agents the user messaged from this phone. An agent's turn
 *   joins the Watch ("Vesper is thinking") only within [RECENT_WINDOW] of such a message;
 *   scheduled and webhook turns never touch it.
 *
 * Both persist (DataStore) and are observable, so the Watch reconciles when they change.
 *
 * ```
 * val sources = WatchSources.get(context)
 * val followed by sources.followedTasks.collectAsStateWithLifecycle()
 * Switch(checked = taskId in followed, onCheckedChange = { sources.setFollowing(taskId, it) })
 * sources.recordAgentSend(agentId)      // after sending a message from the phone
 * ```
 */
class WatchSources(
    private val store: DataStore<Preferences>,
    private val scope: CoroutineScope,
) {
    /** Ids of the followed Repo Tasks. Empty until the store has loaded (a few ms after start). */
    val followedTasks: StateFlow<Set<String>> =
        store.data.map { it[FOLLOWED].orEmpty() }.stateIn(scope, SharingStarted.Eagerly, emptySet())

    /** Agent id → when the user last messaged it from this phone (all entries, expired included). */
    val agentSends: StateFlow<Map<String, Instant>> =
        store.data.map { decodeSends(it[AGENT_SENDS]) }.stateIn(scope, SharingStarted.Eagerly, emptyMap())

    // region Followed tasks

    /** The followed task ids, read from disk (use this off the main thread when it must be exact). */
    suspend fun followed(): Set<String> = store.data.first()[FOLLOWED].orEmpty()

    /** Whether [taskId] is followed (from the observed state). */
    fun isFollowing(taskId: String): Boolean = taskId in followedTasks.value

    /** Follows or unfollows [taskId]. */
    fun setFollowing(
        taskId: String,
        following: Boolean,
    ) {
        scope.launch { if (following) follow(taskId) else unfollow(taskId) }
    }

    /**
     * Toggles [taskId] and returns whether it is followed afterwards, as far as the observed state
     * knows (iOS `FollowedTasks.toggle`). The flip itself is atomic on disk.
     */
    fun toggle(taskId: String): Boolean {
        val nowFollowing = !isFollowing(taskId)
        scope.launch {
            store.edit { prefs ->
                val ids = prefs[FOLLOWED].orEmpty()
                prefs[FOLLOWED] = if (taskId in ids) ids - taskId else ids + taskId
            }
        }
        return nowFollowing
    }

    suspend fun follow(taskId: String) {
        store.edit { it[FOLLOWED] = it[FOLLOWED].orEmpty() + taskId }
    }

    suspend fun unfollow(taskId: String) {
        store.edit { prefs ->
            val ids = prefs[FOLLOWED].orEmpty()
            if (taskId in ids) prefs[FOLLOWED] = ids - taskId
        }
    }

    // endregion

    // region Recent agent sends

    /** Records a message to [agentId] sent from this phone (prunes entries past the window). */
    fun recordAgentSend(
        agentId: String,
        at: Instant = Instant.now(),
    ) {
        scope.launch { recordAgentSendNow(agentId, at) }
    }

    suspend fun recordAgentSendNow(
        agentId: String,
        at: Instant = Instant.now(),
    ) {
        store.edit { prefs ->
            val table = decodeSends(prefs[AGENT_SENDS]).filterValues { isRecent(it, at) } + (agentId to at)
            prefs[AGENT_SENDS] = encodeSends(table)
        }
    }

    /** Agents messaged from this phone within [RECENT_WINDOW] of [now]. */
    suspend fun recentAgentSends(now: Instant = Instant.now()): Map<String, Instant> =
        decodeSends(store.data.first()[AGENT_SENDS]).filterValues { isRecent(it, now) }

    /** Whether [agentId] was messaged from this phone within the window (from the observed state). */
    fun isRecentAgentSend(
        agentId: String,
        now: Instant = Instant.now(),
    ): Boolean = agentSends.value[agentId]?.let { isRecent(it, now) } == true

    // endregion

    companion object {
        /** How long after a message from this phone an agent's turn may join the Watch. */
        val RECENT_WINDOW: Duration = 1.hours

        private val FOLLOWED = stringSetPreferencesKey("optio.followedTasks")
        private val AGENT_SENDS = stringPreferencesKey("optio.recentAgentSends")
        private val sendsSerializer = MapSerializer(String.serializer(), Long.serializer())

        private fun isRecent(
            at: Instant,
            now: Instant,
        ): Boolean = at.isAfter(now.minus(RECENT_WINDOW.toJavaDuration()))

        private fun decodeSends(raw: String?): Map<String, Instant> =
            raw?.let { runCatching { Json.decodeFromString(sendsSerializer, it) }.getOrNull() }?.mapValues { Instant.ofEpochMilli(it.value) }
                .orEmpty()

        private fun encodeSends(table: Map<String, Instant>): String = Json.encodeToString(sendsSerializer, table.mapValues { it.value.toEpochMilli() })

        @Volatile
        private var shared: WatchSources? = null

        /** The process's instance. */
        fun get(context: Context): WatchSources =
            shared ?: synchronized(this) {
                shared ?: WatchSources(
                    PreferenceDataStoreFactory.create { context.applicationContext.preferencesDataStoreFile("optio_watch_sources") },
                    CoroutineScope(SupervisorJob() + Dispatchers.IO),
                ).also { shared = it }
            }

        /** An in-memory instance: tests and previews. */
        fun inMemory(scope: CoroutineScope): WatchSources = WatchSources(InMemoryPreferences(), scope)
    }
}
