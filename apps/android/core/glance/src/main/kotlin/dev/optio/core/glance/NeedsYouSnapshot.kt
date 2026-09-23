@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.core.glance

import dev.optio.core.data.DeepLink
import dev.optio.core.data.ServerClient
import dev.optio.core.data.SessionStore
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import java.time.Instant
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers

/**
 * The data every glanceable surface (widgets, tiles, the Watch notification, the needs-you
 * notifications) reads: what needs you, what's running, and when it was computed (port of iOS
 * `Shared/NeedsYouSnapshot.swift`). Built from the same endpoints the app's Local hub uses, so
 * phone and web agree.
 *
 * ```
 * val one = NeedsYouSnapshot.load(client)                       // one paired server
 * val all = NeedsYouSnapshot.loadAll(session, followed = sources.followed())
 * notification.show(all.snapshot.watchState())
 * ```
 */
@Serializable
data class NeedsYouSnapshot(
    val needsYou: List<GlanceItem> = emptyList(),
    val running: List<GlanceItem> = emptyList(),
    val hostsOnline: Int = 0,
    val hostsTotal: Int = 0,
    /**
     * The session board tiles the items alone cannot tell (`GET /api/glance/watch`); null when the
     * server predates the endpoint or the call failed (auth-disabled servers answer 401).
     */
    val counts: SessionTileCounts? = null,
    val asOf: Instant = Instant.now(),
) {
    /** This snapshot with another server's folded in (items concatenated, hosts and tiles summed). */
    fun merge(other: NeedsYouSnapshot): NeedsYouSnapshot =
        copy(
            needsYou = needsYou + other.needsYou,
            running = running + other.running,
            hostsOnline = hostsOnline + other.hostsOnline,
            hostsTotal = hostsTotal + other.hostsTotal,
            counts = SessionTileCounts.sum(counts, other.counts),
        )

    /**
     * The Watch content per the product brief: oldest needs-you item first (anything under a
     * "Later" window behind everything that isn't), up to two more listed, counts for the rest;
     * the newest running item when nothing needs you; offline when every host is down.
     */
    fun watchState(): GlanceWatchState {
        if (hostsTotal > 0 && hostsOnline == 0) {
            return GlanceWatchState(
                phase = WatchPhase.OFFLINE,
                head = needsYou.firstOrNull(),
                needsYouCount = needsYou.size,
                runningCount = running.size,
                offlineSince = asOf,
                asOf = asOf,
            )
        }
        val sorted = needsYou.sortedWith(GlanceWatchState.needsYouOrder(asOf))
        val head = sorted.firstOrNull()
        if (head != null) {
            return GlanceWatchState(
                phase = WatchPhase.WAITING,
                head = head,
                others = sorted.drop(1).take(GlanceWatchState.OTHERS_MAX),
                needsYouCount = sorted.size,
                runningCount = running.size,
                waitingCount = counts?.waiting,
                recurringCount = counts?.recurring,
                agentCount = counts?.agents,
                asOf = asOf,
            )
        }
        return GlanceWatchState(
            phase = WatchPhase.WORKING,
            head = running.maxByOrNull { it.since },
            needsYouCount = 0,
            runningCount = running.size,
            waitingCount = counts?.waiting,
            recurringCount = counts?.recurring,
            agentCount = counts?.agents,
            asOf = asOf,
        )
    }

    /** Every paired server merged ([loadAll]). */
    data class LoadAllResult(
        /** The merged snapshot, `asOf` = now. */
        val snapshot: NeedsYouSnapshot,
        /** Ids of the servers that failed (skipped). */
        val failed: List<String>,
        /** Each server that answered, by `ServerProfile.id`, in the order the clients were given. */
        val perServer: Map<String, NeedsYouSnapshot>,
        /** Why each failed server failed, by id. */
        val errors: Map<String, Throwable> = emptyMap(),
    )

    companion object {
        val EMPTY = NeedsYouSnapshot(asOf = Instant.EPOCH)

        /** Per-server budget: a sleeping laptop must not hold up the others (iOS `SharedFetch` 8 s per request). */
        val SERVER_TIMEOUT: Duration = 15.seconds

        // region Loading

        /**
         * One paired server's snapshot: its Local hosts and running terminals, [followed] Repo
         * Tasks ("Follow" in task detail; each joins the queue when `needs_attention`/`failed`,
         * else the running list; finished ones are skipped and the caller unfollows them), and the
         * board tiles from `GET /api/glance/watch` when the server has them.
         *
         * @throws ApiError when the hosts or terminals request fails (the server is unreachable or
         *   the token was rejected). Tiles and followed tasks fail quietly.
         */
        suspend fun load(
            client: ServerClient,
            followed: Set<String> = emptySet(),
            now: Instant = Instant.now(),
        ): NeedsYouSnapshot = load(client.api, client.server.id, client.server.shortName, followed, now)

        /** [load] for an ad-hoc client ([serverId] tags the rows and their links). */
        suspend fun load(
            api: ApiClient,
            serverId: String? = null,
            serverName: String? = null,
            followed: Set<String> = emptySet(),
            now: Instant = Instant.now(),
        ): NeedsYouSnapshot =
            coroutineScope {
                val hostsCall = async { api.get<HostsEnvelope>("/api/local/hosts") }
                val termsCall = async { api.get<TerminalsEnvelope>("/api/local/terminals", mapOf("state" to "running")) }
                val tasksCall = async { loadFollowedTasks(api, serverId, serverName, followed, now) }
                // Board tiles from the server's Watch frame; older servers 404 (auth-disabled ones
                // 401) → nil, and the tiles hide.
                val tilesCall = async { runCatching { api.get<WatchTiles>("/api/glance/watch") }.getOrNull() }
                val hosts = hostsCall.await().hosts
                val terms = termsCall.await().terminals
                val hostName = hosts.mapNotNull { h -> h.name?.let { h.id to it } }.distinctBy { it.first }.toMap()
                val needs = mutableListOf<GlanceItem>()
                val running = mutableListOf<GlanceItem>()
                // Agent terminals always count; a plain shell counts once the daemon has seen an
                // agent in it (attention state set by Claude Code hooks / the bell scanner).
                for (t in terms) {
                    val isAgent = t.spec?.kind == "agent"
                    if (t.state != "running" || !(isAgent || t.attentionState == "working" || t.attentionState == "needs_you")) continue
                    val item = terminalItem(t, hostName, serverId, serverName, now)
                    if (t.attentionState == "needs_you") needs += item else running += item
                }
                val tasks = tasksCall.await()
                needs += tasks.first
                running += tasks.second
                val tiles = tilesCall.await()
                val counts =
                    tiles?.takeIf { it.waitingCount != null || it.recurringCount != null || it.agentCount != null }?.let {
                        SessionTileCounts(it.waitingCount ?: 0, it.recurringCount ?: 0, it.agentCount ?: 0)
                    }
                NeedsYouSnapshot(
                    needsYou = needs,
                    running = running,
                    hostsOnline = hosts.count { it.state == "online" },
                    hostsTotal = hosts.size,
                    counts = counts,
                    asOf = now,
                )
            }

        /**
         * Every paired server ([SessionStore.clients], active first) merged into one snapshot.
         * Servers that fail (or take longer than [timeout]) are skipped and listed in
         * [LoadAllResult.failed]; throws only when none answered. Host counts sum across servers.
         */
        suspend fun loadAll(
            session: SessionStore,
            followed: Set<String> = emptySet(),
            timeout: Duration = SERVER_TIMEOUT,
        ): LoadAllResult = loadAll(session.clients(), followed, timeout)

        /** [loadAll] over explicit [clients]. */
        suspend fun loadAll(
            clients: List<ServerClient>,
            followed: Set<String> = emptySet(),
            timeout: Duration = SERVER_TIMEOUT,
            now: () -> Instant = Instant::now,
        ): LoadAllResult {
            if (clients.isEmpty()) throw ApiError(0, "no servers")
            val results =
                coroutineScope {
                    clients.map { c ->
                        async {
                            c.server.id to runCatching { withTimeout(timeout) { load(c, followed, now()) } }
                        }
                    }.awaitAll()
                }
            val perServer = LinkedHashMap<String, NeedsYouSnapshot>()
            val errors = LinkedHashMap<String, Throwable>()
            for ((id, result) in results) {
                result.onSuccess { perServer[id] = it }.onFailure { errors[id] = it }
            }
            if (perServer.isEmpty()) {
                val last = errors.values.lastOrNull()
                throw last as? ApiError ?: ApiError(0, last?.message ?: "unreachable", cause = last)
            }
            val merged = perServer.values.fold(EMPTY) { acc, s -> acc.merge(s) }.copy(asOf = now())
            return LoadAllResult(merged, errors.keys.toList(), perServer, errors)
        }

        /**
         * Followed tasks, split into (needs you, running). Failures per task are ignored (a deleted
         * task simply disappears from the Watch).
         */
        suspend fun loadFollowedTasks(
            api: ApiClient,
            serverId: String?,
            serverName: String?,
            ids: Set<String>,
            now: Instant = Instant.now(),
        ): Pair<List<GlanceItem>, List<GlanceItem>> {
            if (ids.isEmpty()) return emptyList<GlanceItem>() to emptyList()
            val rows =
                coroutineScope {
                    ids.map { id -> async { runCatching { api.get<TaskEnvelope>("/api/tasks/$id").task }.getOrNull() } }.awaitAll()
                }
            val needs = mutableListOf<GlanceItem>()
            val running = mutableListOf<GlanceItem>()
            for (t in rows.filterNotNull()) {
                val item = taskItem(t, serverId, serverName, now) ?: continue
                if (t.state == "needs_attention" || t.state == "failed") needs += item else running += item
            }
            return needs to running
        }

        // endregion

        // region Rows

        /** A running terminal as a Watch row (session chips as the app's session row shows them). */
        internal fun terminalItem(
            t: TerminalRow,
            hostName: Map<String, String>,
            serverId: String?,
            serverName: String?,
            now: Instant,
        ): GlanceItem {
            val spec = t.spec
            val agentSpec = spec?.takeIf { it.kind == "agent" }
            val since = parseDate(t.attentionChangedAt) ?: parseDate(t.updatedAt) ?: parseDate(t.startedAt) ?: now
            val agent = if (agentSpec != null) agentSpec.agent ?: "claude-code" else "terminal"
            val detail = listOfNotNull(t.hostId?.let { hostName[it] }, shortDir(t.dir)).joinToString(" · ")
            return GlanceItem(
                kind = WatchItemKind.LOCAL,
                id = t.id,
                title = t.title,
                mono = t.dir.trimEnd('/').substringAfterLast('/').ifEmpty { t.dir },
                reason = t.attentionReason?.let(::reasonText),
                preview = GlanceItem.clampPreview(t.preview?.split('\n', '\r')?.lastOrNull { it.isNotBlank() }?.trim()),
                since = since,
                state = t.attentionState ?: t.state,
                link = DeepLink.Local(t.id, compose = true).url(server = serverId),
                snoozedUntil = parseDate(t.snoozedUntil),
                serverId = serverId,
                serverName = serverName,
                source = WatchSessionSource.LOCAL_TERMINAL,
                `when` = if ((t.spawnedBy ?: "manual") == "manual") "now" else t.spawnedBy,
                where = WatchWhere(WatchWhereTarget.MACHINE, detail.ifEmpty { null }),
                who = agent,
                then = if (agentSpec?.mode == "headless") WatchThen.EXITS else WatchThen.WAITS_FOR_ME,
                statusLabel = terminalStatusLabel(t.state, t.attentionState),
            )
        }

        /**
         * Watch row for a followed task; null when the task is finished. Copy per the brief:
         * "Queued" → "Running" → "PR #581 open · CI running" → "PR #581 · CI passed · review pending".
         */
        fun taskItem(
            t: TaskRowLite,
            serverId: String? = null,
            serverName: String? = null,
            now: Instant = Instant.now(),
        ): GlanceItem? {
            if (t.state == "completed" || t.state == "cancelled") return null
            val since = parseDate(t.updatedAt) ?: parseDate(t.startedAt) ?: parseDate(t.createdAt) ?: now
            val mono = t.repoBranch ?: t.prNumber?.let { "#$it" } ?: t.repoUrl?.trimEnd('/')?.substringAfterLast('/').orEmpty()
            val local = t.runTarget == "local"
            return GlanceItem(
                kind = WatchItemKind.TASK,
                id = t.id,
                title = t.title,
                mono = mono,
                reason = taskReason(t),
                preview = null,
                since = since,
                state = t.state,
                link = DeepLink.Task(t.id).url(server = serverId),
                prUrl = t.prUrl,
                serverId = serverId,
                serverName = serverName,
                source = WatchSessionSource.REPO_TASK,
                `when` = if (t.metadata?.taskConfigId != null) "on a trigger" else "now",
                where =
                    if (local) {
                        WatchWhere(WatchWhereTarget.MACHINE, t.localDir?.let(::shortDir))
                    } else {
                        WatchWhere(WatchWhereTarget.POD, shortRepo(t.repoUrl))
                    },
                who = t.agentType ?: "claude-code",
                then = WatchThen.EXITS,
                statusLabel = taskStatusLabel(t.state),
            )
        }

        fun taskReason(t: TaskRowLite): String? =
            when (t.state) {
                "needs_attention" -> {
                    val error = t.errorMessage
                    when {
                        error != null && "conflict" in error.lowercase() -> "Merge conflict — resume?"
                        error != null -> error.take(80)
                        else -> "Needs attention — resume?"
                    }
                }
                "failed" -> t.errorMessage?.take(80) ?: "Failed — retry?"
                "pr_opened" -> {
                    val pr = t.prNumber?.let { "PR #$it" } ?: "PR"
                    when (t.prChecksStatus) {
                        "passing" -> "$pr · CI passed · review ${if (t.prReviewStatus == "approved") "approved" else "pending"}"
                        "failing" -> "$pr · CI failing"
                        else -> "$pr open · CI running"
                    }
                }
                "queued", "pending" -> "Queued"
                "provisioning" -> "Starting"
                "running" -> "Running"
                else -> t.state.replace('_', ' ')
            }

        // endregion

        // region Copy helpers (sessions-feed ports)

        /** `/Users/me/repos/x` → `~/repos/x` (sessions-feed `shortDir`). */
        fun shortDir(dir: String): String {
            for (prefix in listOf("/Users/", "/home/")) {
                if (!dir.startsWith(prefix)) continue
                val rest = dir.removePrefix(prefix)
                val slash = rest.indexOf('/')
                return if (slash >= 0) "~" + rest.substring(slash) else "~"
            }
            return dir
        }

        /** `https://github.com/o/r.git` → `o/r` (sessions-feed `shortRepo`). */
        fun shortRepo(url: String?): String? {
            if (url.isNullOrEmpty()) return null
            var s: String = url
            val scheme = s.indexOf("://")
            if (scheme >= 0) {
                s = s.substring(scheme + 3)
                val slash = s.indexOf('/')
                if (slash >= 0) s = s.substring(slash + 1)
            }
            if (s.endsWith(".git")) s = s.dropLast(4)
            return s
        }

        /** Status word for a terminal (sessions-feed `terminalStatus`). */
        fun terminalStatusLabel(
            state: String,
            attentionState: String?,
        ): String =
            when (state) {
                "error" -> "error"
                "exited" -> "exited"
                "pending" -> "pending"
                else ->
                    when (attentionState) {
                        "needs_you" -> "needs you"
                        "idle" -> "idle"
                        else -> "working"
                    }
            }

        /** Status word for a task (sessions-feed `taskStatus`). */
        fun taskStatusLabel(state: String): String =
            when (state) {
                "needs_attention" -> "needs attention"
                "pr_opened" -> "PR open"
                else -> state.replace('_', ' ')
            }

        /** The daemon's attention reason as copy. */
        fun reasonText(raw: String): String =
            when (raw) {
                "notification" -> "Waiting on a permission"
                "stop" -> "Claude stopped — reply to continue"
                "quiet", "silence" -> "Gone quiet"
                else -> raw.replace('_', ' ')
            }

        /** An ISO-8601 date, or null when absent / unparseable (rows must never fail on one date). */
        internal fun parseDate(text: String?): Instant? =
            text?.let { runCatching { FlexibleInstantSerializer.parse(it) }.getOrNull() }

        // endregion
    }
}

// region Wire rows (loose on purpose: every optional field may be missing on older servers)

@Serializable
internal data class HostRow(
    val id: String,
    val name: String? = null,
    val state: String = "offline",
)

@Serializable
internal data class HostsEnvelope(
    val hosts: List<HostRow> = emptyList(),
)

@Serializable
internal data class TerminalSpecLite(
    val kind: String? = null,
    val agent: String? = null,
    val mode: String? = null,
)

@Serializable
internal data class TerminalRow(
    val id: String,
    val title: String = "",
    val dir: String = "",
    val state: String = "",
    val hostId: String? = null,
    val spawnedBy: String? = null,
    val attentionState: String? = null,
    val attentionReason: String? = null,
    val preview: String? = null,
    val attentionChangedAt: String? = null,
    val startedAt: String? = null,
    val updatedAt: String? = null,
    val snoozedUntil: String? = null,
    val spec: TerminalSpecLite? = null,
)

@Serializable
internal data class TerminalsEnvelope(
    val terminals: List<TerminalRow> = emptyList(),
)

/** Only the tiles are read from the server's Watch frame; items come from the lists. */
@Serializable
internal data class WatchTiles(
    val waitingCount: Int? = null,
    val recurringCount: Int? = null,
    val agentCount: Int? = null,
)

/** The part of `GET /api/tasks/:id` the Watch needs. */
@Serializable
data class TaskRowLite(
    val id: String,
    val title: String = "",
    val state: String = "",
    val repoBranch: String? = null,
    val repoUrl: String? = null,
    val prUrl: String? = null,
    val prNumber: Int? = null,
    val prChecksStatus: String? = null,
    val prReviewStatus: String? = null,
    val errorMessage: String? = null,
    val agentType: String? = null,
    val runTarget: String? = null,
    val localDir: String? = null,
    val metadata: Metadata? = null,
    val retryCount: Int? = null,
    val maxRetries: Int? = null,
    val updatedAt: String? = null,
    val startedAt: String? = null,
    val createdAt: String? = null,
) {
    @Serializable
    data class Metadata(
        val taskConfigId: String? = null,
    )
}

@Serializable
internal data class TaskEnvelope(
    val task: TaskRowLite,
)

// endregion
