package dev.optio.feature.widgets.model

import dev.optio.core.data.DeepLink
import dev.optio.core.data.ServerProfile
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import java.time.Instant
import kotlinx.serialization.Serializable

/** The three board tiles the items alone cannot tell (`GET /api/glance/watch`); summed across servers. */
@Serializable
data class TileCounts(
    val waiting: Int,
    val recurring: Int,
    val agents: Int,
) {
    companion object {
        /** Sum across servers; null only when neither side has tiles. */
        fun sum(
            a: TileCounts?,
            b: TileCounts?,
        ): TileCounts? =
            when {
                a == null -> b
                b == null -> a
                else -> TileCounts(a.waiting + b.waiting, a.recurring + b.recurring, a.agents + b.agents)
            }
    }
}

/**
 * A Repo Task in flight, as much of `GET /api/tasks` as the Work widget needs (iOS
 * `InFlightTask`). Loose on purpose: every optional field may be missing on older servers.
 */
@Serializable
data class InFlightTask(
    val id: String,
    val title: String,
    val state: String,
    val repoBranch: String? = null,
    val repoUrl: String? = null,
    val agentType: String? = null,
    val runTarget: String? = null,
    val localDir: String? = null,
    val prNumber: Int? = null,
    val prUrl: String? = null,
    val prChecksStatus: String? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val startedAt: Instant? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val updatedAt: Instant? = null,
    @Serializable(with = FlexibleInstantSerializer::class)
    val createdAt: Instant? = null,
    /** Set by the loader: which paired server the task came from. */
    val serverId: String? = null,
    val serverName: String? = null,
) {
    /** When it entered its current state, as best we know; null when the server sent no dates. */
    val since: Instant?
        get() = startedAt ?: updatedAt ?: createdAt

    val branch: String
        get() = repoBranch.orEmpty()
}

/**
 * One paired server's contribution to a glance (iOS `GlanceSlice`): its needs-you and running
 * sessions, the tiles, its in-flight tasks and how much to trust them.
 */
data class GlanceSlice(
    val server: ServerProfile,
    val reachability: GlancePolicy.Reachability,
    /** Oldest first, snoozed items last (the loader orders them). */
    val needsYou: List<WidgetItem>,
    /** Newest first. */
    val running: List<WidgetItem>,
    val counts: TileCounts? = null,
    /** When this server's snapshot was computed. */
    val asOf: Instant,
    val tasks: List<InFlightTask> = emptyList(),
    /** First failed reload since the last success, when [reachability] is unreachable. */
    val unreachableSince: Instant? = null,
)

/**
 * What every read-only widget renders (iOS `GlanceEntry` + the `WorkWidget.swift` extension): one
 * slice per server the widget shows (one when configured for a server, every paired server
 * otherwise), the merged views the layouts read, and the Work board's ranking.
 */
data class GlanceEntry(
    val date: Instant,
    val slices: List<GlanceSlice>,
    /** Other servers are paired even though this widget shows one (single-server layouts name theirs). */
    val othersPaired: Boolean = false,
) {
    /** True when the widget shows more than one server (rows carry server dots). */
    val isMulti: Boolean
        get() = slices.size > 1

    val reachability: GlancePolicy.Reachability
        get() =
            when {
                slices.isEmpty() -> GlancePolicy.Reachability.SIGNED_OUT
                slices.any { it.reachability == GlancePolicy.Reachability.LIVE } -> GlancePolicy.Reachability.LIVE
                else -> GlancePolicy.Reachability.UNREACHABLE
            }

    /** Servers that failed their last reload. */
    val unreachableSlices: List<GlanceSlice>
        get() = slices.filter { it.reachability == GlancePolicy.Reachability.UNREACHABLE }

    /** Oldest first across servers, snoozed items last. */
    val needsYou: List<WidgetItem>
        get() =
            if (slices.size == 1) {
                slices[0].needsYou
            } else {
                slices.flatMap { it.needsYou }.sortedWith(compareBy<WidgetItem> { it.isSnoozed(date) }.thenBy { it.since })
            }

    /** Newest first across servers. */
    val running: List<WidgetItem>
        get() = if (slices.size == 1) slices[0].running else slices.flatMap { it.running }.sortedByDescending { it.since }

    val tasks: List<InFlightTask>
        get() = slices.flatMap { it.tasks }

    /** The oldest slice's snapshot time (the whole entry is only as fresh as that). */
    val asOf: Instant
        get() = slices.minOfOrNull { it.asOf } ?: date

    val isStale: Boolean
        get() = GlancePolicy.isStale(asOf, date)

    val unreachableSince: Instant?
        get() = unreachableSlices.mapNotNull { it.unreachableSince }.minOrNull()

    /** Server-supplied board tiles summed across servers; null when no server sent them. */
    val tileCounts: TileCounts?
        get() = slices.fold(null as TileCounts?) { sum, slice -> TileCounts.sum(sum, slice.counts) }

    /** The one server a single-server layout labels itself with (null when showing several). */
    val server: ServerProfile?
        get() = slices.singleOrNull()?.server

    /** Whether single-server layouts show the server name at all. */
    val showsServerName: Boolean
        get() = server != null && othersPaired

    /** The paired server [id], for row dots. */
    fun serverProfile(id: String?): ServerProfile? = id?.let { wanted -> slices.firstOrNull { it.server.id == wanted }?.server }

    // region The Work board (iOS WorkWidget.swift)

    /** Repo Tasks in flight that are not already rows, as session rows with the four attributes. */
    val taskRows: List<WidgetItem>
        get() {
            val seen = (needsYou + running).map { it.id }.toSet()
            return tasks.filter { it.id !in seen }.map { t ->
                val reason =
                    when (t.prChecksStatus) {
                        "failing" -> "CI failing"
                        "passing" -> "CI passed"
                        else -> null
                    }
                val local = t.runTarget == "local"
                WidgetItem(
                    kind = WatchItemKind.TASK,
                    id = t.id,
                    title = t.title,
                    mono = t.branch.ifEmpty { t.prNumber?.let { "#$it" } ?: t.title },
                    reason = reason,
                    since = t.since ?: date,
                    state = t.state,
                    link = DeepLink.Task(t.id).url(server = t.serverId),
                    prUrl = t.prUrl,
                    serverId = t.serverId,
                    serverName = t.serverName,
                    `when` = "now",
                    where =
                        if (local) {
                            WatchWhere(WatchWhereTarget.MACHINE, t.localDir?.let(SessionText::shortDir))
                        } else {
                            WatchWhere(WatchWhereTarget.POD, SessionText.shortRepo(t.repoUrl))
                        },
                    who = t.agentType ?: "claude-code",
                    then = WatchThen.EXITS,
                    statusLabel = SessionText.taskStatusLabel(t.state),
                )
            }
        }

    /**
     * Every active session the widget knows, ranked like the app: needs-you (oldest first, snoozed
     * last), then running (newest first), then waiting at an open PR.
     */
    val sessionRows: List<WidgetItem>
        get() {
            val extra = taskRows
            val needs = needsYou + extra.filter { it.waitsOnYou }
            val live = (running + extra.filter { !it.waitsOnYou && it.state != "pr_opened" }).sortedByDescending { it.since }
            val waiting = extra.filter { !it.waitsOnYou && it.state == "pr_opened" }
            return needs + live + waiting
        }

    /** Board numbers: needs-you and running from the rows, the rest from the server. */
    val needsYouCount: Int
        get() = sessionRows.count { it.waitsOnYou }

    val runningCount: Int
        get() = sessionRows.count { !it.waitsOnYou && it.state != "pr_opened" }

    val tiles: List<GlanceCopy.Tile>
        get() = tileCounts.let { GlanceCopy.tiles(needsYouCount, runningCount, it?.waiting, it?.recurring, it?.agents) }

    /** The head session: oldest needs-you, else newest running. */
    val headSession: WidgetItem?
        get() = sessionRows.firstOrNull()

    /** Where a tap on the widget chrome lands: Work, Active view (on this widget's server when it shows one). */
    val boardLink: String
        get() = DeepLink.Work("active").url(server = server?.id)

    /** A tile's link: the Work list in the tile's view. */
    fun tileLink(tile: GlanceCopy.Tile): String = DeepLink.Work(tile.view).url(server = server?.id)

    /** Where a tap on a compact surface lands: the head session, else the board. */
    val headLink: String
        get() = headSession?.link ?: boardLink

    // endregion

    companion object {
        fun signedOut(date: Instant): GlanceEntry = GlanceEntry(date, emptyList())
    }
}

/** Session-row copy shared with the app's Work feed (iOS `NeedsYouSnapshot` helpers). */
internal object SessionText {
    /** `/Users/me/repos/x` → `~/repos/x`. */
    fun shortDir(dir: String): String {
        for (prefix in listOf("/Users/", "/home/")) {
            if (!dir.startsWith(prefix)) continue
            val rest = dir.removePrefix(prefix)
            val slash = rest.indexOf('/')
            return if (slash >= 0) "~" + rest.substring(slash) else "~"
        }
        return dir
    }

    /** `https://github.com/o/r.git` → `o/r`. */
    fun shortRepo(url: String?): String? {
        var s = url?.takeIf { it.isNotEmpty() } ?: return null
        val scheme = s.indexOf("://")
        if (scheme >= 0) {
            s = s.substring(scheme + 3)
            val slash = s.indexOf('/')
            if (slash >= 0) s = s.substring(slash + 1)
        }
        return s.removeSuffix(".git")
    }

    /** Status word for a task. */
    fun taskStatusLabel(state: String): String =
        when (state) {
            "needs_attention" -> "needs attention"
            "pr_opened" -> "PR open"
            else -> state.replace('_', ' ')
        }
}
