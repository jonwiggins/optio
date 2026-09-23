package dev.optio.feature.widgets.refresh

import android.content.Context
import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.feature.widgets.data.CachedItem
import dev.optio.feature.widgets.data.CachedSlice
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.model.InFlightTask
import dev.optio.feature.widgets.model.TileCounts
import dev.optio.feature.widgets.model.WidgetItem
import dev.optio.feature.widgets.run.attempt
import java.time.Instant
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable

/** One server's needs-you snapshot as the widgets use it. */
data class LoadedSnapshot(
    val needsYou: List<WidgetItem>,
    val running: List<WidgetItem>,
    val counts: TileCounts? = null,
    val hostsOnline: Int = 0,
    val hostsTotal: Int = 0,
    val asOf: Instant,
)

/** Loads one server's snapshot; throws when the server cannot be reached. */
fun interface SnapshotSource {
    suspend fun load(client: ServerClient): LoadedSnapshot
}

/**
 * Fetches every paired server for the widgets and tiles (iOS `GlanceTimelineProvider.loadSlice`,
 * run by the app instead of a timeline): the needs-you snapshot and the Repo Tasks in flight, one
 * server at a time failing independently. A server that answers replaces its cache; one that does
 * not keeps its last good snapshot and is marked unreachable since its first failure, so only its
 * own rows are flagged. Then every widget and tile re-renders.
 */
internal object WidgetRefresher {
    /** Where snapshots come from (`:core:glance`'s `NeedsYouSnapshot`). */
    @Volatile
    var snapshots: SnapshotSource = SnapshotSource { throw IllegalStateException("No snapshot source") }

    private val mutex = Mutex()

    suspend fun refresh(
        context: Context,
        session: SessionStore,
    ) {
        val store = WidgetStore.get(context)
        mutex.withLock {
            val clients = session.clients()
            store.retainServers(clients.map { it.server.id }.toSet())
            coroutineScope { clients.map { async { refreshServer(store, it) } }.awaitAll() }
        }
        WidgetUpdates.updateWork(context)
        WidgetUpdates.requestTiles(context)
        WidgetTicks.scheduleStaleFlip(context)
    }

    private suspend fun refreshServer(
        store: WidgetStore,
        client: ServerClient,
    ) {
        coroutineScope {
            val snapshot = async { attempt { snapshots.load(client) } }
            val tasks = async { attempt { client.api.inFlightTasks(client.server) } }
            val loaded = snapshot.await()
            if (loaded == null) {
                store.markUnreachable(client.server.id, Instant.now())
                return@coroutineScope
            }
            val previous = WidgetStore.cached(store.snapshot(), client.server.id)
            store.setCached(
                CachedSlice(
                    serverId = client.server.id,
                    needsYou = loaded.needsYou.map(CachedItem::of),
                    running = loaded.running.map(CachedItem::of),
                    counts = loaded.counts,
                    hostsOnline = loaded.hostsOnline,
                    hostsTotal = loaded.hostsTotal,
                    asOf = loaded.asOf,
                    tasks = tasks.await() ?: previous?.tasks.orEmpty(),
                    unreachableSince = null,
                ),
            )
        }
    }
}

@Serializable
private data class TasksEnvelope(val tasks: List<InFlightTask> = emptyList())

private val inFlightStates = setOf("running", "provisioning", "queued", "pr_opened", "needs_attention")

/**
 * The Repo Tasks in flight on [server] (iOS `GlanceTimelineProvider.loadTasks`): the newest eight,
 * the in-flight ones, at most four, tagged with their server.
 */
internal suspend fun ApiClient.inFlightTasks(server: ServerProfile): List<InFlightTask> =
    get<TasksEnvelope>("/api/tasks", mapOf("limit" to 8, "type" to "repo-task"))
        .tasks
        .filter { it.state in inFlightStates }
        .take(4)
        .map { it.copy(serverId = server.id, serverName = server.shortName) }
