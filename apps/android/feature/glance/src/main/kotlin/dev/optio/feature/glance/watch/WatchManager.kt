package dev.optio.feature.glance.watch

import android.util.Log
import dev.optio.core.data.DeepLink
import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlanceLoader
import dev.optio.core.glance.GlanceRefresh
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.glance.WatchCopy
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.AndroidPushWatchEvent
import dev.optio.core.model.PersistentAgentStateChangedEvent
import dev.optio.core.model.PersistentAgentTurnHaltedEvent
import dev.optio.core.model.PersistentAgentTurnStartedEvent
import dev.optio.core.model.TaskRecoveredEvent
import dev.optio.core.model.TaskStalledEvent
import dev.optio.core.model.TaskState
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchState
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.model.WsEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import dev.optio.feature.glance.getAgentLite
import dev.optio.feature.glance.getTaskState
import dev.optio.feature.glance.notifications.NeedsYouNotifier
import java.time.Duration
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeout

/** What the Watch reads from the app: the paired servers and the live event stream. */
interface WatchHost {
    /** Every paired server with a client, active first. */
    suspend fun clients(): List<ServerClient>

    /** The paired servers (drives forgetting). */
    val servers: StateFlow<List<ServerProfile>>

    /** `/ws/events` of the active server while its socket runs (in the foreground or while retained). */
    val events: Flow<WsEvent>

    /** The active server, for frames that do not name theirs. */
    val activeServerId: String?
}

/**
 * Owns the one Watch notification (port of iOS `Core/LiveActivity/LiveActivityManager.swift`).
 *
 * Every paired server feeds it: a check of a server ([reconcile]: its Local terminals needing you or
 * running, the tasks the user follows, agent turns the user started from this phone in the last
 * hour) or an FCM Watch frame ([applyFrame]) sets that server's entry on a board, and the Watch
 * shows the board merged ([GlanceWatchState.merge]). Wake-ups come from `/ws/events` (debounced
 * 500 ms), the foreground poll (30 s; 2 min while "Keep watching" runs in the background), the
 * background check (WorkManager), and pushes.
 *
 * It starts when something needs you or runs, updates only when what it shows changes, turns
 * "offline" after 90 s of every server failing, and ends after 2 min with nothing running or
 * waiting with a summary ("Sessions ended. 3 answered, 1 PR merged.") that stays 15 min.
 *
 * FCM frames follow `docs/android-push.md`: an `update` for a Watch that is not showing counts as a
 * `start`; an `end` for one that is not showing is ignored; a frame older than the last one from
 * the same server is dropped.
 */
class WatchManager(
    private val scope: CoroutineScope,
    private val host: WatchHost,
    private val sources: WatchSources,
    private val glanceStore: GlanceStore,
    private val store: WatchStore,
    private val notifier: WatchNotifier,
    private val needsYou: NeedsYouNotifier,
    /** True when the app is on screen (drives the 30 s poll). */
    private val foreground: () -> Boolean = { false },
    /** Called when something needs you while the app is open (the notification permission prompt). */
    private val onNeedsYouWhileOpen: () -> Unit = {},
    /** After new data was cached: widgets and tiles re-render. */
    private val refreshSurfaces: suspend (GlanceRefresh.Reason) -> Unit = {},
    private val clock: () -> Instant = Instant::now,
    private val serverTimeout: kotlin.time.Duration = NeedsYouSnapshot.SERVER_TIMEOUT,
) {
    private val mutex = Mutex()
    private val loader = GlanceLoader(glanceStore, host::clients, serverTimeout)
    private var memory: WatchMemory? = null
    private var firstFailureAt: Instant? = null
    private var lastPosted: GlanceWatchState? = null
    private var debounce: Job? = null
    private var quietTimer: Job? = null
    private var jobs: List<Job> = emptyList()

    private val _display = MutableStateFlow<GlanceWatchState?>(null)

    /** What the Watch shows (or would show), for status rows; null before the first reconcile. */
    val display: StateFlow<GlanceWatchState?> = _display.asStateFlow()

    private val _showing = MutableStateFlow(false)

    /** Whether the Watch notification is up. */
    val showing: StateFlow<Boolean> = _showing.asStateFlow()

    @Volatile
    private var keepWatching = false

    /** The last reconcile's error (every server failed), for status rows. */
    @Volatile
    var lastError: String? = null
        private set

    // region Lifecycle

    /** Starts listening (events, sources, servers) and polling. Idempotent. */
    fun start() {
        if (jobs.isNotEmpty()) return
        jobs =
            listOf(
                scope.launch { host.events.collect(::handle) },
                scope.launch { sources.followedTasks.drop(1).collect { reconcileSoon() } },
                scope.launch { sources.agentSends.drop(1).collect { reconcileSoon() } },
                scope.launch { host.servers.drop(1).collect { serversChanged(it) } },
                scope.launch {
                    // iOS polls every 30 s while foregrounded; "Keep watching" polls the other
                    // servers every 2 min in the background (the socket covers the active one).
                    while (true) {
                        delay(if (keepWatching && !foreground()) KEEP_WATCHING_POLL else FOREGROUND_POLL)
                        if (foreground() || keepWatching) reconcile(GlanceRefresh.Reason.APP)
                    }
                },
            )
        reconcileSoon()
    }

    /** Stops listening (tests). */
    fun stop() {
        jobs.forEach { it.cancel() }
        jobs = emptyList()
        debounce?.cancel()
        quietTimer?.cancel()
    }

    /** Coalesced recompute (500 ms), for events and UI actions. */
    fun reconcileSoon(reason: GlanceRefresh.Reason = GlanceRefresh.Reason.EVENTS) {
        debounce?.cancel()
        debounce =
            scope.launch {
                delay(DEBOUNCE)
                reconcile(reason)
            }
    }

    // endregion

    // region Reconcile (checks of every paired server)

    /** Checks every paired server and applies the result. Serialized; safe to call from anywhere. */
    suspend fun reconcile(reason: GlanceRefresh.Reason = GlanceRefresh.Reason.APP) {
        mutex.withLock {
            try {
                computeAndApply()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "reconcile failed", e)
            }
        }
        runCatching { refreshSurfaces(reason) }
    }

    private suspend fun computeAndApply() {
        val now = clock()
        val clients = host.clients()
        var mem = memory()
        if (clients.isEmpty()) {
            // Signed out: the Watch belongs to the user, so it goes at once.
            endNow()
            return
        }
        val ids = clients.map { it.server.id }.toSet()
        mem = mem.copy(board = mem.board.filterKeys { it in ids }, lastPushAsOf = mem.lastPushAsOf.filterKeys { it in ids })

        val followed = sources.followed()
        val results =
            coroutineScope {
                clients.map { c ->
                    async { c to runCatching { withTimeout(serverTimeout) { NeedsYouSnapshot.load(c, followed, now) } } }
                }.awaitAll()
            }
        val ok = results.mapNotNull { (c, r) -> r.getOrNull()?.let { c to it } }
        val failed = results.filter { it.second.isFailure }.map { it.first }
        for (c in failed) loader.rememberFailure(c.server.id, now)
        // A server that failed keeps only a recent pushed frame (it may push while unreachable here).
        val failedIds = failed.map { it.server.id }.toSet()
        var board = mem.board.filter { (id, e) -> id !in failedIds || (e.source == BoardEntry.Source.PUSH && Duration.between(e.receivedAt, now) < PUSH_FRESH) }

        if (ok.isEmpty()) {
            lastError = results.firstNotNullOfOrNull { it.second.exceptionOrNull()?.message } ?: "unreachable"
            val since = firstFailureAt ?: now
            firstFailureAt = since
            board = board.filterValues { it.source == BoardEntry.Source.PUSH && Duration.between(it.receivedAt, now) < PUSH_FRESH }
            memory = mem.copy(board = board)
            if (board.isNotEmpty()) {
                apply(GlanceWatchState.merge(board.values.map { it.state }, now), now)
            } else if (Duration.between(since, now) >= OFFLINE_AFTER) {
                // Under 90 s of failure keep the last frame; after that, say so.
                val last = _display.value
                apply(
                    GlanceWatchState(
                        phase = WatchPhase.OFFLINE,
                        head = last?.head,
                        needsYouCount = last?.needsYouCount ?: 0,
                        runningCount = last?.runningCount ?: 0,
                        offlineSince = since,
                        asOf = now,
                    ),
                    now,
                )
            }
            save()
            return
        }
        firstFailureAt = null
        lastError = null

        // Followed tasks that fell out of every answering server are finished (or gone): unfollow.
        val present = ok.flatMap { (_, s) -> (s.needsYou + s.running).filter { it.kind == WatchItemKind.TASK }.map { it.id } }.toSet()
        for (id in followed - present) confirmUnfollow(id, clients)

        // Persistent-agent turns started from this phone in the last hour. Ids are UUIDs: the first
        // server that knows one owns it.
        val agentRows = agentItems(ok.map { it.first }, now)

        val snapshots =
            ok.map { (c, s) ->
                val agents = agentRows.filter { it.serverId == c.server.id }
                val withAgents =
                    s.copy(
                        needsYou = s.needsYou + agents.filter { it.state == "failed" },
                        running = s.running + agents.filter { it.state != "failed" },
                    )
                c to mirrorLocalSnoozes(withAgents, now)
            }

        // "Answered" = items that left the needs-you set while the Watch was up.
        val current = snapshots.flatMap { (_, s) -> s.needsYou.map { it.id } }.toSet()
        if (mem.showing) mem = mem.copy(answered = mem.answered + (mem.pendingIds - current).size)
        mem = mem.copy(pendingIds = current)

        for ((c, s) in snapshots) {
            val id = c.server.id
            loader.remember(id, s)
            runCatching { needsYou.notifyNew(id, s, now) }.onFailure { Log.w(TAG, "needs-you alerts for $id failed", it) }
            board = board + (id to BoardEntry(s.watchState(), now, BoardEntry.Source.POLL))
        }
        memory = mem.copy(board = board)
        if (current.isNotEmpty() && foreground()) onNeedsYouWhileOpen()
        // Like iOS, the answering servers are merged as one snapshot first (hosts add up, so the
        // Watch is offline only when every host is down), then joined by pushed frames from
        // servers this check could not reach.
        val checked = snapshots.fold(NeedsYouSnapshot.EMPTY) { acc, (_, s) -> acc.merge(s) }.copy(asOf = now).watchState()
        val okIds = snapshots.map { it.first.server.id }.toSet()
        val pushedOnly = board.filter { (id, e) -> id !in okIds && e.source == BoardEntry.Source.PUSH }.values.map { it.state }
        apply(GlanceWatchState.merge(listOf(checked) + pushedOnly, now), now)
        save()
    }

    /**
     * Unfollows once every paired server agrees the task is finished or unknown; a transient
     * failure on any server keeps the follow (a 404 on the wrong laptop is not proof it is gone).
     */
    private suspend fun confirmUnfollow(
        id: String,
        clients: List<ServerClient>,
    ) {
        for (c in clients) {
            try {
                if (!c.api.getTaskState(id).isFinished) return
            } catch (e: ApiError) {
                if (e.status != ApiError.NOT_FOUND) return
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                return
            }
        }
        sources.unfollow(id)
    }

    private suspend fun agentItems(
        clients: List<ServerClient>,
        now: Instant,
    ): List<GlanceItem> {
        val recent = sources.recentAgentSends(now)
        if (recent.isEmpty()) return emptyList()
        val out = mutableListOf<GlanceItem>()
        for (agentId in recent.keys) {
            var found: Pair<dev.optio.feature.glance.AgentLite, ServerClient>? = null
            for (c in clients) {
                val row = runCatching { c.api.getAgentLite(agentId) }.getOrNull()
                if (row != null) {
                    found = row to c
                    break
                }
            }
            val (row, c) = found ?: continue
            agentItem(row, c.server, now)?.let(out::add)
        }
        return out
    }

    /** "Later" pressed here before the server learned about it (or on an older server). */
    private suspend fun mirrorLocalSnoozes(
        snapshot: NeedsYouSnapshot,
        now: Instant,
    ): NeedsYouSnapshot {
        val local = glanceStore.snoozedUntil(snapshot.needsYou.map { it.id })
        if (local.isEmpty()) return snapshot
        return snapshot.copy(
            needsYou =
                snapshot.needsYou.map { item ->
                    val until = local[item.id]
                    if (item.snoozedUntil == null && until != null && until.isAfter(now)) item.copy(snoozedUntil = until) else item
                },
        )
    }

    // endregion

    // region Push frames

    /** What happened to a pushed frame. */
    enum class FrameResult { APPLIED, STALE, IGNORED_END, ENDED }

    /**
     * An FCM Watch frame from [serverId] (`AndroidPushWatch`): the server's whole Watch as it sees
     * it. Update-as-start, ignore an unknown end, drop out-of-order frames (docs/android-push.md).
     */
    suspend fun applyFrame(
        serverId: String?,
        event: AndroidPushWatchEvent,
        wire: WatchState,
    ): FrameResult {
        val result =
            mutex.withLock {
                val now = clock()
                var mem = memory()
                val id = serverId ?: host.activeServerId ?: UNKNOWN_SERVER
                val name = host.servers.value.firstOrNull { it.id == id }?.shortName
                val frame = GlanceWatchState.fromWire(wire, id, name)
                val last = mem.lastPushAsOf[id]
                if (last != null && frame.asOf.isBefore(last)) return@withLock FrameResult.STALE
                mem = mem.copy(lastPushAsOf = mem.lastPushAsOf + (id to frame.asOf))
                val result =
                    if (event == AndroidPushWatchEvent.END) {
                        val board = mem.board - id
                        memory = mem.copy(board = board)
                        if (!mem.showing) {
                            FrameResult.IGNORED_END
                        } else {
                            val merged = GlanceWatchState.merge(board.values.map { it.state }, now)
                            if (board.isEmpty() || !merged.hasWork) {
                                endWithSummary(now, frame.summary)
                                FrameResult.ENDED
                            } else {
                                apply(merged, now)
                                FrameResult.APPLIED
                            }
                        }
                    } else {
                        val board = mem.board + (id to BoardEntry(frame, now, BoardEntry.Source.PUSH))
                        memory = mem.copy(board = board)
                        apply(GlanceWatchState.merge(board.values.map { it.state }, now), now)
                        FrameResult.APPLIED
                    }
                save()
                result
            }
        runCatching { refreshSurfaces(GlanceRefresh.Reason.PUSH) }
        return result
    }

    // endregion

    // region Apply

    private suspend fun apply(
        state: GlanceWatchState,
        now: Instant,
    ) {
        _display.value = state
        var mem = memory()
        val hasWork = state.hasWork
        mem = mem.copy(quietSince = if (hasWork) null else mem.quietSince ?: now)
        memory = mem

        if (!mem.showing) {
            val identity = identity(state)
            if (hasWork && mem.dismissedIdentity != identity) {
                if (notifier.post(notifier.build(state, multiServer(), keepWatching))) {
                    lastPosted = state.contentKey
                    memory = mem.copy(showing = true, answered = 0, merged = 0, dismissedIdentity = null, quietSince = null)
                    _showing.value = true
                }
            } else if (keepWatching) {
                postKeepWatching(null)
            }
            return
        }

        val quietSince = mem.quietSince
        if (!hasWork && quietSince != null && Duration.between(quietSince, now) >= QUIET_WINDOW) {
            endWithSummary(now, null)
            return
        }
        if (!hasWork) scheduleQuietTimer()
        if (state.contentKey != lastPosted) {
            if (notifier.post(notifier.build(state, multiServer(), keepWatching))) lastPosted = state.contentKey
        }
    }

    private suspend fun endWithSummary(
        now: Instant,
        serverSummary: String?,
    ) {
        val mem = memory()
        val summary =
            if (mem.answered + mem.merged > 0 || serverSummary == null) WatchCopy.endSummary(mem.answered, mem.merged) else serverSummary
        _display.value = GlanceWatchState(WatchPhase.DONE, summary = summary, asOf = now)
        if (keepWatching) postKeepWatching(summary) else notifier.post(notifier.buildEnded(summary))
        memory = mem.copy(showing = false, quietSince = null, pendingIds = emptySet(), answered = 0, merged = 0)
        lastPosted = null
        _showing.value = false
        quietTimer?.cancel()
    }

    /** Sign-out: the Watch goes immediately (iOS `stop()` → `.immediate`). */
    private suspend fun endNow() {
        if (!keepWatching) notifier.cancel()
        memory = WatchMemory()
        lastPosted = null
        _display.value = null
        _showing.value = false
        quietTimer?.cancel()
        save()
    }

    private fun scheduleQuietTimer() {
        if (quietTimer?.isActive == true) return
        quietTimer =
            scope.launch {
                delay(QUIET_WINDOW.toMillis() + 1_000)
                reconcile(GlanceRefresh.Reason.APP)
            }
    }

    private fun postKeepWatching(summary: String?) {
        val servers = host.servers.value
        val line =
            summary ?: when (servers.size) {
                0 -> "Nothing needs you"
                1 -> "Nothing needs you · watching ${servers[0].shortName}"
                else -> "Nothing needs you · watching ${servers.size} servers"
            }
        notifier.post(notifier.buildKeepWatching(line))
    }

    private fun multiServer(): Boolean = host.servers.value.size > 1

    // endregion

    // region Events and outside changes

    private fun handle(event: WsEvent) {
        when (event) {
            is TaskStateChangedEvent -> {
                // iOS PushRegistrar: the first thing needing you while the app is open is when to ask.
                if (event.toState == TaskState.NEEDS_ATTENTION && foreground()) onNeedsYouWhileOpen()
                if (!sources.isFollowing(event.taskId)) return
                when (event.toState) {
                    TaskState.COMPLETED -> {
                        scope.launch {
                            mutex.withLock { memory = memory().let { if (it.showing) it.copy(merged = it.merged + 1) else it } }
                            sources.unfollow(event.taskId)
                        }
                    }
                    TaskState.CANCELLED -> scope.launch { sources.unfollow(event.taskId) }
                    else -> Unit
                }
                reconcileSoon()
            }
            is TaskStalledEvent -> if (sources.isFollowing(event.taskId)) reconcileSoon()
            is TaskRecoveredEvent -> if (sources.isFollowing(event.taskId)) reconcileSoon()
            is PersistentAgentTurnStartedEvent -> if (sources.isRecentAgentSend(event.agentId)) reconcileSoon()
            is PersistentAgentTurnHaltedEvent -> if (sources.isRecentAgentSend(event.agentId)) reconcileSoon()
            is PersistentAgentStateChangedEvent -> if (sources.isRecentAgentSend(event.agentId)) reconcileSoon()
            is WsEvent.Unknown -> if (event.raw["type"]?.stringValue?.startsWith("local:") == true) reconcileSoon()
            else -> Unit
        }
    }

    private suspend fun serversChanged(servers: List<ServerProfile>) {
        val ids = servers.map { it.id }.toSet()
        val gone =
            mutex.withLock {
                val mem = memory()
                val gone = (mem.board.keys + mem.lastPushAsOf.keys).filter { it !in ids }
                memory = mem.copy(board = mem.board.filterKeys { it in ids }, lastPushAsOf = mem.lastPushAsOf.filterKeys { it in ids })
                gone
            }
        for (id in gone) {
            glanceStore.forgetServer(id)
            needsYou.forget(id)
        }
        reconcileSoon(GlanceRefresh.Reason.APP)
    }

    /** The user swiped the Watch away: stop showing it until what it shows changes. */
    suspend fun userDismissed() {
        mutex.withLock {
            val mem = memory()
            memory = mem.copy(showing = false, dismissedIdentity = _display.value?.let(::identity))
            lastPosted = null
            _showing.value = false
            save()
        }
    }

    /** The keep-watching service started or stopped: its notification takes over the Watch's slot. */
    suspend fun keepWatchingChanged(active: Boolean) {
        mutex.withLock {
            keepWatching = active
            val mem = memory()
            val state = _display.value
            if (mem.showing && state != null) {
                notifier.post(notifier.build(state, multiServer(), active))
                lastPosted = state.contentKey
            } else if (active) {
                postKeepWatching(null)
            } else {
                notifier.cancel()
            }
        }
        if (active) reconcileSoon(GlanceRefresh.Reason.APP)
    }

    /** The notification the keep-watching service starts in the foreground with (sync; no I/O). */
    fun foregroundNotification(): android.app.Notification {
        val state = _display.value
        return if (state != null && _showing.value) notifier.build(state, multiServer(), keepWatching = true) else notifier.buildKeepWatching("Watching for sessions that need you")
    }

    // endregion

    private suspend fun memory(): WatchMemory {
        memory?.let { return it }
        var loaded = store.load()
        // The system is the truth about whether a Watch is up (dismissed or rebooted since).
        if (loaded.showing && !keepWatching && !notifier.isShowing) loaded = loaded.copy(showing = false)
        memory = loaded
        _showing.value = loaded.showing
        if (loaded.showing) lastPosted = null
        return loaded
    }

    private suspend fun save() {
        memory?.let { store.save(it) }
    }

    companion object {
        private const val TAG = "OptioWatch"

        val DEBOUNCE = 500.milliseconds
        val QUIET_WINDOW: Duration = Duration.ofMinutes(2)
        val OFFLINE_AFTER: Duration = Duration.ofSeconds(90)

        /** A pushed frame keeps its server on the Watch this long while the phone cannot reach it. */
        val PUSH_FRESH: Duration = Duration.ofMinutes(10)
        val FOREGROUND_POLL = 30.seconds
        val KEEP_WATCHING_POLL = 120.seconds

        /** Board key for frames that name no server while none is active. */
        const val UNKNOWN_SERVER = "unknown"

        /** What the Watch is about (a dismissed Watch comes back when this changes). */
        fun identity(state: GlanceWatchState): String = "${state.phase.raw}|${state.head?.id}|${state.needsYouCount}"

        /**
         * A persistent agent's turn as a Watch row (iOS `LiveActivityManager` agent rows): running /
         * queued / provisioning → running ("thinking"), failed → needs you. Null otherwise.
         */
        fun agentItem(
            row: dev.optio.feature.glance.AgentLite,
            server: ServerProfile,
            now: Instant,
        ): GlanceItem? {
            val since = NeedsYouSnapshotDates.parse(row.lastTurnAt) ?: now
            fun item(
                reason: String?,
                statusLabel: String,
            ) = GlanceItem(
                kind = WatchItemKind.AGENT,
                id = row.id,
                title = row.name,
                mono = "@${row.slug}",
                reason = reason,
                since = since,
                state = row.state,
                link = DeepLink.Agent(row.id, compose = true).url(server = server.id),
                serverId = server.id,
                serverName = server.shortName,
                source = WatchSessionSource.PERSISTENT_AGENT,
                `when` = "messages",
                where = WatchWhere(WatchWhereTarget.POD, "@${row.slug}"),
                who = row.agentRuntime ?: "claude-code",
                then = WatchThen.WAITS_FOR_MESSAGES,
                statusLabel = statusLabel,
            )
            return when (row.state) {
                "running", "queued", "provisioning" -> item(null, if (row.state == "running") "thinking" else row.state)
                "failed" -> item(row.lastFailureReason?.take(80) ?: "Turn failed — resume?", "failed")
                else -> null
            }
        }

        /** Test helper: a host with fixed clients. */
        internal fun fixedHost(
            clients: List<ServerClient>,
            events: Flow<WsEvent> = emptyFlow(),
        ): WatchHost =
            object : WatchHost {
                override suspend fun clients() = clients

                override val servers = MutableStateFlow(clients.map { it.server })
                override val events = events
                override val activeServerId = clients.firstOrNull()?.server?.id
            }
    }
}

/** ISO dates on the lite rows (never fail a row on one date). */
internal object NeedsYouSnapshotDates {
    fun parse(text: String?): Instant? = text?.let { runCatching { dev.optio.core.model.FlexibleInstantSerializer.parse(it) }.getOrNull() }
}
