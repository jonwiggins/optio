package dev.optio.core.glance

import android.content.Context
import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.PreferenceDataStoreFactory
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.longPreferencesKey
import androidx.datastore.preferences.core.stringPreferencesKey
import androidx.datastore.preferences.preferencesDataStoreFile
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.model.OptioJson
import java.time.Instant
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.map
import kotlinx.serialization.KSerializer
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.ListSerializer

/**
 * What the glanceable surfaces remember between loads (port of iOS `GlanceStore`, which kept
 * these in App Group defaults; widgets, tiles and workers share the app process here, so one
 * DataStore file serves them all):
 *
 * - the last good [NeedsYouSnapshot] and in-flight tasks **per server**, so an offline reload
 *   renders stale-with-asOf instead of blank, plus since when each server has been unreachable;
 * - local "Later" snoozes (`optio.snoozed.<id>`), the fallback when the snooze request fails;
 * - the Run widget / tile's armed and started timestamps.
 *
 * ```
 * val store = GlanceStore.get(context)
 * val cached = store.mergedCachedSnapshot(session.servers.value.map { it.id })
 * ```
 */
class GlanceStore(
    private val store: DataStore<Preferences>,
) {
    /** Emits whenever anything in the store changes (widgets can re-render from the cache). */
    val changes: Flow<Unit> = store.data.map { }

    // region Snapshot cache (per server)

    suspend fun cachedSnapshot(serverId: String): NeedsYouSnapshot? = read(Keys.snapshot(serverId), NeedsYouSnapshot.serializer())

    suspend fun setCachedSnapshot(
        snapshot: NeedsYouSnapshot?,
        serverId: String,
    ) = write(Keys.snapshot(serverId), snapshot, NeedsYouSnapshot.serializer())

    suspend fun cachedTasks(serverId: String): List<InFlightTask> = read(Keys.tasks(serverId), taskList).orEmpty()

    suspend fun setCachedTasks(
        tasks: List<InFlightTask>,
        serverId: String,
    ) = write(Keys.tasks(serverId), tasks, taskList)

    /** First failed reload after the last success; cleared on success. */
    suspend fun unreachableSince(serverId: String): Instant? = readInstant(Keys.unreachableSince(serverId))

    suspend fun setUnreachableSince(
        date: Instant?,
        serverId: String,
    ) = writeInstant(Keys.unreachableSince(serverId), date)

    /**
     * Every listed server's last good snapshot merged (tiles and controls read this so they can say
     * "Quiet" without a network call); `asOf` is the oldest one. Null when nothing is cached.
     */
    suspend fun mergedCachedSnapshot(serverIds: List<String>): NeedsYouSnapshot? {
        var merged: NeedsYouSnapshot? = null
        for (id in serverIds) {
            val s = cachedSnapshot(id) ?: continue
            merged = merged?.merge(s)?.copy(asOf = minOf(merged.asOf, s.asOf)) ?: s
        }
        return merged
    }

    /** Drops everything cached for a forgotten server. */
    suspend fun forgetServer(serverId: String) {
        store.edit {
            it.remove(stringPreferencesKey(Keys.snapshot(serverId)))
            it.remove(stringPreferencesKey(Keys.tasks(serverId)))
            it.remove(longPreferencesKey(Keys.unreachableSince(serverId)))
        }
    }

    // endregion

    // region Snooze (Later)

    /** Records a local "Later" for [id] until [until] (the widgets and the Watch read it). */
    suspend fun snooze(
        id: String,
        until: Instant,
    ) = writeInstant(Keys.snoozed(id), until)

    /** Drops the local "Later" for [id] (the server's snooze took over, or it was undone). */
    suspend fun clearSnooze(id: String) = writeInstant(Keys.snoozed(id), null)

    /** The local snoozes of [ids] (expired ones included; compare with now). */
    suspend fun snoozedUntil(ids: Collection<String>): Map<String, Instant> {
        val prefs = store.data.first()
        return ids.mapNotNull { id -> prefs[longPreferencesKey(Keys.snoozed(id))]?.let { id to Instant.ofEpochMilli(it) } }.toMap()
    }

    /** The local snooze of one item, if any. */
    suspend fun snoozedUntil(id: String): Instant? = readInstant(Keys.snoozed(id))

    // endregion

    // region Run widget / tile

    suspend fun armedAt(targetId: String): Instant? = readInstant(Keys.armed(targetId))

    suspend fun setArmed(
        targetId: String,
        at: Instant?,
    ) = writeInstant(Keys.armed(targetId), at)

    suspend fun startedAt(targetId: String): Instant? = readInstant(Keys.started(targetId))

    suspend fun setStarted(
        targetId: String,
        at: Instant?,
    ) = writeInstant(Keys.started(targetId), at)

    // endregion

    // region Internals

    private suspend fun <T> read(
        key: String,
        serializer: KSerializer<T>,
    ): T? {
        val raw = store.data.first()[stringPreferencesKey(key)] ?: return null
        return runCatching { OptioJson.decodeFromString(serializer, raw) }.getOrNull()
    }

    private suspend fun <T> write(
        key: String,
        value: T?,
        serializer: KSerializer<T>,
    ) {
        val encoded = value?.let { cacheJson.encodeToString(serializer, it) }
        store.edit { if (encoded == null) it.remove(stringPreferencesKey(key)) else it[stringPreferencesKey(key)] = encoded }
    }

    private suspend fun readInstant(key: String): Instant? = store.data.first()[longPreferencesKey(key)]?.let(Instant::ofEpochMilli)

    private suspend fun writeInstant(
        key: String,
        value: Instant?,
    ) {
        store.edit { if (value == null) it.remove(longPreferencesKey(key)) else it[longPreferencesKey(key)] = value.toEpochMilli() }
    }

    // endregion

    /** Key names, as on iOS. */
    object Keys {
        fun snapshot(serverId: String) = "optio.glance.snapshot.$serverId"

        fun tasks(serverId: String) = "optio.glance.tasks.$serverId"

        fun unreachableSince(serverId: String) = "optio.glance.unreachableSince.$serverId"

        fun snoozed(id: String) = "optio.snoozed.$id"

        fun armed(id: String) = "optio.run.armed.$id"

        fun started(id: String) = "optio.run.started.$id"
    }

    companion object {
        private val taskList = ListSerializer(InFlightTask.serializer())

        // Cached values keep every field (defaults included) so a later decode sees what was stored.
        private val cacheJson = kotlinx.serialization.json.Json(OptioJson) { encodeDefaults = true }

        @Volatile
        private var shared: GlanceStore? = null

        /** The process's store (one DataStore per file per process). */
        fun get(context: Context): GlanceStore =
            shared ?: synchronized(this) {
                shared ?: GlanceStore(
                    PreferenceDataStoreFactory.create { context.applicationContext.preferencesDataStoreFile("optio_glance") },
                ).also { shared = it }
            }

        /** A store held in memory: tests and previews. */
        fun inMemory(): GlanceStore = GlanceStore(InMemoryPreferences())
    }
}

/**
 * A Repo Task in flight, as much of `GET /api/tasks` as the Sessions widget needs (iOS
 * `InFlightTask`). Loose on purpose: every optional field may be missing on older servers.
 */
@Serializable
data class InFlightTask(
    val id: String,
    val title: String = "",
    val state: String = "",
    val repoBranch: String? = null,
    val repoUrl: String? = null,
    val agentType: String? = null,
    val runTarget: String? = null,
    val localDir: String? = null,
    val prNumber: Int? = null,
    val prUrl: String? = null,
    val prChecksStatus: String? = null,
    val startedAt: String? = null,
    val updatedAt: String? = null,
    val createdAt: String? = null,
    /** Set after decoding: which paired server the task came from. */
    val serverId: String? = null,
    val serverName: String? = null,
) {
    /** When it started (else last update, else creation). */
    val since: Instant
        get() =
            NeedsYouSnapshot.parseDate(startedAt) ?: NeedsYouSnapshot.parseDate(updatedAt) ?: NeedsYouSnapshot.parseDate(createdAt)
                ?: Instant.EPOCH

    val branch: String
        get() = repoBranch.orEmpty()

    companion object {
        /** The states the widget lists as "in flight". */
        val IN_FLIGHT_STATES = setOf("running", "provisioning", "queued", "pr_opened", "needs_attention")
    }
}
