package dev.optio.core.glance

import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import java.time.Instant
import kotlin.time.Duration
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable

/** One paired server's contribution to a glance: its snapshot, tasks and how much to trust them (iOS `GlanceSlice`). */
data class GlanceSlice(
    val server: ServerProfile,
    val reachability: GlancePolicy.Reachability,
    val snapshot: NeedsYouSnapshot,
    val tasks: List<InFlightTask>,
    /** First failed reload since the last success, when [reachability] is `UNREACHABLE`. */
    val unreachableSince: Instant?,
) {
    val count: Int
        get() = snapshot.needsYou.size
}

/**
 * Everything a widget / tile renders at one moment (iOS `GlanceEntry`): one [GlanceSlice] per
 * server it shows (one when configured for a server, every paired server otherwise) plus the
 * merged views single-server layouts read.
 */
data class GlanceEntry(
    val date: Instant,
    val slices: List<GlanceSlice>,
    /** Other servers are paired even though this entry shows one (single layouts still name it). */
    val othersPaired: Boolean = false,
) {
    /** More than one server (sectioned / server-dotted layouts). */
    val isMulti: Boolean
        get() = slices.size > 1

    val reachability: GlancePolicy.Reachability
        get() =
            when {
                slices.isEmpty() -> GlancePolicy.Reachability.SIGNED_OUT
                slices.any { it.reachability == GlancePolicy.Reachability.LIVE } -> GlancePolicy.Reachability.LIVE
                else -> GlancePolicy.Reachability.UNREACHABLE
            }

    /** Servers that failed their last reload while others answered. */
    val unreachableSlices: List<GlanceSlice>
        get() = slices.filter { it.reachability == GlancePolicy.Reachability.UNREACHABLE }

    /** Every slice merged: oldest needs-you first across servers (snoozed last), newest running first. */
    val snapshot: NeedsYouSnapshot by lazy {
        if (slices.size == 1) return@lazy slices[0].snapshot
        var merged = NeedsYouSnapshot.EMPTY.copy(asOf = Instant.MAX)
        for (s in slices) merged = merged.merge(s.snapshot).copy(asOf = minOf(merged.asOf, s.snapshot.asOf))
        if (merged.asOf == Instant.MAX) merged = merged.copy(asOf = date)
        merged.copy(
            needsYou = merged.needsYou.sortedWith(GlanceWatchState.needsYouOrder(date)),
            running = merged.running.sortedByDescending { it.since },
        )
    }

    val tasks: List<InFlightTask>
        get() = slices.flatMap { it.tasks }
    val asOf: Instant
        get() = snapshot.asOf
    val isStale: Boolean
        get() = GlancePolicy.isStale(asOf, date)
    val needsYou: List<GlanceItem>
        get() = snapshot.needsYou
    val running: List<GlanceItem>
        get() = snapshot.running
    val count: Int
        get() = snapshot.needsYou.size
    val unreachableSince: Instant?
        get() = unreachableSlices.mapNotNull { it.unreachableSince }.minOrNull()

    /** Server-supplied board tiles (summed across servers); null on older servers. */
    val tileCounts: SessionTileCounts?
        get() = snapshot.counts

    /** The one server a single-server layout labels itself with (null when showing several). */
    val server: ServerProfile?
        get() = slices.singleOrNull()?.server

    /** Whether single-server layouts should show the server name at all. */
    val showsServerName: Boolean
        get() = server != null && othersPaired

    /** The board tiles for this entry (Need you / Running always, the rest when the server has them). */
    val tiles: List<GlanceCopy.Tile>
        get() = GlanceCopy.tiles(count, running.size, tileCounts?.waiting, tileCounts?.recurring, tileCounts?.agents)

    /** When to load again (iOS timeline policy). */
    val refreshInterval: Duration
        get() = GlancePolicy.refreshInterval(reachability, anyRunning = running.isNotEmpty(), anyNeedsYou = needsYou.isNotEmpty())

    companion object {
        fun signedOut(date: Instant = Instant.now()): GlanceEntry = GlanceEntry(date, emptyList())
    }
}

/**
 * Loads glance entries for the widgets, tiles and the background refresh (the loading half of iOS
 * `GlanceTimelineProvider`): one fetch per server per load, the last good snapshot cached per
 * server in [store], and an unreachable server rendered from its cache with "unreachable since".
 *
 * ```
 * val loader = GlanceLoader(GlanceStore.get(context), session)
 * val entry = loader.load()                       // every paired server, live
 * val quick = loader.cached()                     // no network: last good data
 * ```
 */
class GlanceLoader(
    private val store: GlanceStore,
    /** The paired servers with their clients, active first (`SessionStore.clients()`). */
    private val clients: suspend () -> List<ServerClient>,
    private val timeout: Duration = NeedsYouSnapshot.SERVER_TIMEOUT,
) {
    constructor(store: GlanceStore, session: SessionStore) : this(store, { session.clients() })

    /**
     * A live entry for [serverId] (still paired), else every paired server; [includeTasks] also
     * lists Repo Tasks in flight (large layouts). [followed] joins followed tasks to the rows.
     */
    suspend fun load(
        serverId: String? = null,
        includeTasks: Boolean = false,
        followed: Set<String> = emptySet(),
        now: Instant = Instant.now(),
    ): GlanceEntry {
        val all = clients()
        val chosen = all.filter { it.server.id == serverId }.ifEmpty { all }
        if (chosen.isEmpty()) return GlanceEntry.signedOut(now)
        val slices = coroutineScope { chosen.map { c -> async { loadSlice(c, includeTasks, followed, now) } }.awaitAll() }
        return GlanceEntry(now, slices, othersPaired = all.size > chosen.size)
    }

    /** The last good data for [serverId] / every paired server, without touching the network. */
    suspend fun cached(
        serverId: String? = null,
        now: Instant = Instant.now(),
    ): GlanceEntry {
        val all = clients()
        val chosen = all.filter { it.server.id == serverId }.ifEmpty { all }
        if (chosen.isEmpty()) return GlanceEntry.signedOut(now)
        val slices =
            chosen.map { c ->
                val id = c.server.id
                val since = store.unreachableSince(id)
                GlanceSlice(
                    server = c.server,
                    reachability = if (since == null) GlancePolicy.Reachability.LIVE else GlancePolicy.Reachability.UNREACHABLE,
                    snapshot = ordered(store.cachedSnapshot(id) ?: NeedsYouSnapshot.EMPTY.copy(asOf = now), now),
                    tasks = store.cachedTasks(id),
                    unreachableSince = since,
                )
            }
        return GlanceEntry(now, slices, othersPaired = all.size > chosen.size)
    }

    /** One server, live; on failure its cached snapshot marked unreachable (and since when). */
    suspend fun loadSlice(
        client: ServerClient,
        includeTasks: Boolean = false,
        followed: Set<String> = emptySet(),
        now: Instant = Instant.now(),
    ): GlanceSlice {
        val id = client.server.id
        val (snapshot, tasks) =
            coroutineScope {
                val snap = async { runCatching { withTimeout(timeout) { NeedsYouSnapshot.load(client, followed, now) } }.getOrNull() }
                val tasks = async { if (includeTasks) loadTasks(client.api, client.server) else null }
                snap.await() to tasks.await()
            }
        if (snapshot != null) {
            store.setCachedSnapshot(snapshot, id)
            store.setUnreachableSince(null, id)
            if (tasks != null) store.setCachedTasks(tasks, id)
            return GlanceSlice(client.server, GlancePolicy.Reachability.LIVE, ordered(snapshot, now), tasks ?: store.cachedTasks(id), null)
        }
        // Unreachable: keep the last good snapshot and say since when.
        val since = store.unreachableSince(id) ?: now
        store.setUnreachableSince(since, id)
        val cached = store.cachedSnapshot(id) ?: NeedsYouSnapshot.EMPTY.copy(asOf = now)
        return GlanceSlice(client.server, GlancePolicy.Reachability.UNREACHABLE, ordered(cached, now), store.cachedTasks(id), since)
    }

    /**
     * Records a live [snapshot] loaded elsewhere (the Watch, the background refresh) as [serverId]'s
     * last good data, so widgets and tiles render it without a load of their own.
     */
    suspend fun remember(
        serverId: String,
        snapshot: NeedsYouSnapshot,
    ) {
        store.setCachedSnapshot(snapshot, serverId)
        store.setUnreachableSince(null, serverId)
    }

    /** Marks [serverId] unreachable since [now] unless it already was. */
    suspend fun rememberFailure(
        serverId: String,
        now: Instant = Instant.now(),
    ) {
        if (store.unreachableSince(serverId) == null) store.setUnreachableSince(now, serverId)
    }

    /** Oldest first, with locally snoozed items (Later) moved to the back and mirrored onto the rows. */
    suspend fun ordered(
        snapshot: NeedsYouSnapshot,
        now: Instant,
    ): NeedsYouSnapshot {
        val sorted = snapshot.needsYou.sortedBy { it.since }
        val snoozes = store.snoozedUntil(sorted.map { it.id })
        return orderedWith(snapshot, snoozes, now)
    }

    companion object {
        /** [ordered] with explicit local [snoozes] (pure; tests). */
        fun orderedWith(
            snapshot: NeedsYouSnapshot,
            snoozes: Map<String, Instant>,
            now: Instant,
        ): NeedsYouSnapshot {
            val sorted = snapshot.needsYou.sortedBy { it.since }
            val needs =
                GlancePolicy.applySnooze(sorted, { it.id }, snoozes, now).map { item ->
                    // Mirror a local "Later" onto the row so merged (multi-server) ordering sees it too.
                    val local = snoozes[item.id]
                    if (local != null && local.isAfter(now) && (item.snoozedUntil ?: Instant.MIN).isBefore(local)) item.copy(snoozedUntil = local) else item
                }
            return snapshot.copy(needsYou = needs, running = snapshot.running.sortedByDescending { it.since })
        }

        /** Repo Tasks in flight on one server (`GET /api/tasks?type=repo-task`), up to four. */
        suspend fun loadTasks(
            api: ApiClient,
            server: ServerProfile,
        ): List<InFlightTask>? =
            runCatching {
                api.get<TasksEnvelope>("/api/tasks", mapOf("limit" to 8, "type" to "repo-task")).tasks
                    .filter { it.state in InFlightTask.IN_FLIGHT_STATES }
                    .take(4)
                    .map { it.copy(serverId = server.id, serverName = server.shortName) }
            }.getOrNull()
    }
}

@Serializable
internal data class TasksEnvelope(
    val tasks: List<InFlightTask> = emptyList(),
)
