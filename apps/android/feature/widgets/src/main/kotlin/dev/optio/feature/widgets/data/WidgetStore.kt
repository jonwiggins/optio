package dev.optio.feature.widgets.data

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.booleanPreferencesKey
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStore
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.OptioJson
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.feature.widgets.model.InFlightTask
import dev.optio.feature.widgets.model.TileCounts
import dev.optio.feature.widgets.model.WidgetItem
import dev.optio.feature.widgets.run.RunTarget
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.serialization.Serializable

/** One DataStore per process for everything the widgets, tiles and shortcuts persist. */
private val Context.widgetsDataStore: DataStore<Preferences> by preferencesDataStore(name = "optio_widgets")

/**
 * The widgets' own persistence (iOS `GlanceStore` in App Group defaults): the last good snapshot
 * per server, so an offline reload renders stale-with-asOf instead of blank; since when each
 * server has been unreachable; the local mirror of "Later"; the Run widget's armed / started
 * timestamps per target; and the Run tile's target.
 *
 * Widgets share the app process, so there is no App Group: one DataStore, read by the Glance
 * sessions (as a flow, so a refresh recomposes a running session) and written by the refresher
 * and the actions.
 */
class WidgetStore(private val store: DataStore<Preferences>) {
    /** Every change (compositions collect this and derive their entry from it). */
    val data: Flow<Preferences>
        get() = store.data

    suspend fun snapshot(): Preferences = store.data.first()

    // region Snapshot cache (per server)

    suspend fun setCached(slice: CachedSlice) {
        store.edit { it[cacheKey(slice.serverId)] = OptioJson.encodeToString(CachedSlice.serializer(), slice) }
    }

    /** Marks [serverId] unreachable, keeping its last good snapshot; the first failure's time sticks. */
    suspend fun markUnreachable(
        serverId: String,
        now: Instant,
    ) {
        store.edit { prefs ->
            val cached = cached(prefs, serverId)
            val since = cached?.unreachableSince ?: now
            val next = (cached ?: CachedSlice(serverId = serverId, asOf = now)).copy(unreachableSince = since)
            prefs[cacheKey(serverId)] = OptioJson.encodeToString(CachedSlice.serializer(), next)
        }
    }

    /** Drops the caches of servers that are no longer paired. */
    suspend fun retainServers(ids: Set<String>) {
        store.edit { prefs ->
            prefs.asMap().keys.filter { it.name.startsWith(CACHE_PREFIX) && it.name.removePrefix(CACHE_PREFIX) !in ids }.forEach { prefs.remove(it) }
        }
    }

    // endregion

    // region Later (local mirror of the server-side snooze)

    suspend fun snooze(
        itemId: String,
        until: Instant,
    ) {
        store.edit { it[snoozeKey(itemId)] = until.toEpochMilli() }
    }

    // endregion

    // region Run widget / tile

    suspend fun setArmed(
        targetId: String,
        at: Instant?,
    ) {
        store.edit { if (at == null) it.remove(armedKey(targetId)) else it[armedKey(targetId)] = at.toEpochMilli() }
    }

    suspend fun setStarted(
        targetId: String,
        at: Instant?,
    ) {
        store.edit { if (at == null) it.remove(startedKey(targetId)) else it[startedKey(targetId)] = at.toEpochMilli() }
    }

    /** A named on/off flag (e.g. "the Needs-you tile is in the panel"). */
    suspend fun setFlag(
        name: String,
        on: Boolean,
    ) {
        store.edit { if (on) it[flagKey(name)] = true else it.remove(flagKey(name)) }
    }

    suspend fun setTileTarget(target: RunTarget?) {
        store.edit { if (target == null) it.remove(TILE_TARGET) else it[TILE_TARGET] = OptioJson.encodeToString(RunTarget.serializer(), target) }
    }

    // endregion

    companion object {
        private const val CACHE_PREFIX = "cache."
        private val TILE_TARGET = stringPreferencesKey("tile.run.target")

        private fun cacheKey(serverId: String) = stringPreferencesKey(CACHE_PREFIX + serverId)

        private fun snoozeKey(itemId: String) = longPreferencesKey("snoozed.$itemId")

        private fun armedKey(targetId: String) = longPreferencesKey("run.armed.$targetId")

        private fun startedKey(targetId: String) = longPreferencesKey("run.started.$targetId")

        private fun flagKey(name: String) = booleanPreferencesKey("flag.$name")

        fun flag(
            prefs: Preferences,
            name: String,
        ): Boolean = prefs[flagKey(name)] == true

        @Volatile
        private var shared: WidgetStore? = null

        /** The process's store. */
        fun get(context: Context): WidgetStore =
            shared ?: synchronized(this) {
                shared ?: WidgetStore(context.applicationContext.widgetsDataStore).also { shared = it }
            }

        // Readers over a Preferences snapshot (compositions read these from the collected flow).

        fun cached(
            prefs: Preferences,
            serverId: String,
        ): CachedSlice? = prefs[cacheKey(serverId)]?.let { runCatching { OptioJson.decodeFromString(CachedSlice.serializer(), it) }.getOrNull() }

        /** Local "Later" windows for [ids] (only the ones that are set). */
        fun snoozedUntil(
            prefs: Preferences,
            ids: Collection<String>,
        ): Map<String, Instant> = ids.mapNotNull { id -> prefs[snoozeKey(id)]?.let { id to Instant.ofEpochMilli(it) } }.toMap()

        fun armedAt(
            prefs: Preferences,
            targetId: String,
        ): Instant? = prefs[armedKey(targetId)]?.let(Instant::ofEpochMilli)

        fun startedAt(
            prefs: Preferences,
            targetId: String,
        ): Instant? = prefs[startedKey(targetId)]?.let(Instant::ofEpochMilli)

        fun tileTarget(prefs: Preferences): RunTarget? =
            prefs[TILE_TARGET]?.let { runCatching { OptioJson.decodeFromString(RunTarget.serializer(), it) }.getOrNull() }
    }
}

/** One server's last load as the widgets cache it. */
@Serializable
data class CachedSlice(
    val serverId: String,
    val needsYou: List<CachedItem> = emptyList(),
    val running: List<CachedItem> = emptyList(),
    val counts: TileCounts? = null,
    val hostsOnline: Int = 0,
    val hostsTotal: Int = 0,
    @Serializable(with = FlexibleInstantSerializer::class)
    val asOf: Instant,
    val tasks: List<InFlightTask> = emptyList(),
    /** First failed load since the last success; null while the server answers. */
    @Serializable(with = FlexibleInstantSerializer::class)
    val unreachableSince: Instant? = null,
)

/** [WidgetItem] as stored. */
@Serializable
data class CachedItem(
    val kind: WatchItemKind,
    val id: String,
    val title: String,
    val mono: String,
    val reason: String? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val since: Instant,
    val state: String,
    val link: String,
    val prUrl: String? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val snoozedUntil: Instant? = null,
    val serverId: String? = null,
    val serverName: String? = null,
    val `when`: String? = null,
    val where: WatchWhere? = null,
    val who: String? = null,
    val then: WatchThen? = null,
    val statusLabel: String? = null,
) {
    fun toItem(): WidgetItem = WidgetItem(kind, id, title, mono, reason, since, state, link, prUrl, snoozedUntil, serverId, serverName, `when`, where, who, then, statusLabel)

    companion object {
        fun of(item: WidgetItem): CachedItem =
            CachedItem(
                item.kind, item.id, item.title, item.mono, item.reason, item.since, item.state, item.link, item.prUrl, item.snoozedUntil,
                item.serverId, item.serverName, item.`when`, item.where, item.who, item.then, item.statusLabel,
            )
    }
}
