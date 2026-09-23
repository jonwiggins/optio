@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.feature.glance.watch

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.OptioJson
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.json.Json

/**
 * One server's latest Watch frame on the board the Watch merges: from a check of the server
 * ([Source.POLL], device clock) or from an FCM frame ([Source.PUSH], server clock).
 */
@Serializable
data class BoardEntry(
    val state: GlanceWatchState,
    val receivedAt: Instant,
    val source: Source,
) {
    @Serializable
    enum class Source { POLL, PUSH }
}

/**
 * What the Watch must remember across process death (a push can start the process, post, and the
 * process can die before the next one): the board, whether a Watch is showing, the last push
 * `asOf` per server (frames older than it are dropped), the quiet window, and the summary counts.
 */
@Serializable
data class WatchMemory(
    val showing: Boolean = false,
    val board: Map<String, BoardEntry> = emptyMap(),
    val lastPushAsOf: Map<String, Instant> = emptyMap(),
    val quietSince: Instant? = null,
    val answered: Int = 0,
    val merged: Int = 0,
    val pendingIds: Set<String> = emptySet(),
    /** The Watch the user swiped away; not re-posted until what it shows changes. */
    val dismissedIdentity: String? = null,
)

/** Persistence for [WatchMemory] and the "Keep watching" switch. */
class WatchStore(
    private val store: DataStore<Preferences>,
) {
    suspend fun load(): WatchMemory =
        store.data.first()[MEMORY]?.let { runCatching { json.decodeFromString(WatchMemory.serializer(), it) }.getOrNull() } ?: WatchMemory()

    suspend fun save(memory: WatchMemory) {
        val encoded = json.encodeToString(WatchMemory.serializer(), memory)
        store.edit { it[MEMORY] = encoded }
    }

    /** "Keep watching in the background" is on. */
    val keepWatching: Flow<Boolean> = store.data.map { it[KEEP_WATCHING] ?: false }.distinctUntilChanged()

    suspend fun keepWatching(): Boolean = keepWatching.first()

    suspend fun setKeepWatching(on: Boolean) {
        store.edit { it[KEEP_WATCHING] = on }
    }

    companion object {
        private val MEMORY = stringPreferencesKey("optio.watch.memory")
        private val KEEP_WATCHING = booleanPreferencesKey("optio.watch.keepWatching")
        private val json = Json(OptioJson) { encodeDefaults = true }

        @Volatile
        private var shared: WatchStore? = null

        fun get(context: Context): WatchStore =
            shared ?: synchronized(this) {
                shared ?: WatchStore(
                    PreferenceDataStoreFactory.create { context.applicationContext.preferencesDataStoreFile("optio_watch") },
                ).also { shared = it }
            }

        fun inMemory(): WatchStore = WatchStore(InMemoryPreferences())
    }
}
