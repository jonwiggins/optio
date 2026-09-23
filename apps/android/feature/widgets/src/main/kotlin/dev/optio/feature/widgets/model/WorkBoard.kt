package dev.optio.feature.widgets.model

import dev.optio.core.data.DeepLink
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.GlanceCopy
import dev.optio.core.glance.GlanceEntry
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlanceStatus
import dev.optio.core.glance.InFlightTask
import dev.optio.core.glance.NeedsYouSnapshot
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.ui.theme.StatusKind
import java.time.Instant

// The Work board over a glance entry: iOS `WorkWidget.swift`'s `extension GlanceEntry`. The entry
// (`:core:glance`) holds each server's cached snapshot and in-flight Repo Tasks; these rank them
// into the widget's rows and count the board.

/** Repo Tasks in flight that are not already rows (followed tasks join the snapshot), as session rows. */
val GlanceEntry.taskRows: List<GlanceItem>
    get() {
        val seen = (needsYou + running).map { it.id }.toSet()
        return tasks.filter { it.id !in seen }.map { taskRow(it, date) }
    }

/** One in-flight task as a session row with the four attributes. */
internal fun taskRow(
    t: InFlightTask,
    date: Instant,
): GlanceItem {
    val reason =
        when (t.prChecksStatus) {
            "failing" -> "CI failing"
            "passing" -> "CI passed"
            else -> null
        }
    val local = t.runTarget == "local"
    return GlanceItem(
        kind = WatchItemKind.TASK,
        id = t.id,
        title = t.title,
        mono = t.branch.ifEmpty { t.prNumber?.let { "#$it" } ?: t.title },
        reason = reason,
        since = t.since.takeIf { it != Instant.EPOCH } ?: date,
        state = t.state,
        link = DeepLink.Task(t.id).url(server = t.serverId),
        prUrl = t.prUrl,
        serverId = t.serverId,
        serverName = t.serverName,
        source = WatchSessionSource.REPO_TASK,
        `when` = "now",
        where =
            if (local) {
                WatchWhere(WatchWhereTarget.MACHINE, t.localDir?.let(NeedsYouSnapshot::shortDir))
            } else {
                WatchWhere(WatchWhereTarget.POD, NeedsYouSnapshot.shortRepo(t.repoUrl))
            },
        who = t.agentType ?: "claude-code",
        then = WatchThen.EXITS,
        statusLabel = NeedsYouSnapshot.taskStatusLabel(t.state),
    )
}

/**
 * Every active session the widget knows, ranked like the app: needs-you (oldest first, snoozed
 * last), then running (newest first), then waiting at an open PR.
 */
val GlanceEntry.sessionRows: List<GlanceItem>
    get() {
        val extra = taskRows
        val needs = needsYou + extra.filter { it.waitsOnYou }
        val live = (running + extra.filter { !it.waitsOnYou && it.state != "pr_opened" }).sortedByDescending { it.since }
        val waiting = extra.filter { !it.waitsOnYou && it.state == "pr_opened" }
        return needs + live + waiting
    }

/** Board numbers: needs-you and running from the rows (tasks included), the rest from the server. */
val GlanceEntry.needsYouCount: Int
    get() = sessionRows.count { it.waitsOnYou }

val GlanceEntry.runningCount: Int
    get() = sessionRows.count { !it.waitsOnYou && it.state != "pr_opened" }

/** The board's tiles (iOS `WorkWidget` tiles: Need you / Running from the rows, the rest from the server). */
val GlanceEntry.boardTiles: List<GlanceCopy.Tile>
    get() = tileCounts.let { GlanceCopy.tiles(needsYouCount, runningCount, it?.waiting, it?.recurring, it?.agents) }

/** The head session: oldest needs-you, else newest running. */
val GlanceEntry.headSession: GlanceItem?
    get() = sessionRows.firstOrNull()

/** Where a tap on the widget chrome lands: Work, Active view (on this widget's server when it shows one). */
val GlanceEntry.boardLink: String
    get() = DeepLink.Work("active").url(server = server?.id)

/** A tile's link: the Work list in the tile's view (on this widget's server when it shows one). */
fun GlanceEntry.tileLink(tile: GlanceCopy.Tile): String = tile.link(server?.id)

/** Where a tap on a compact surface lands: the head session, else the board. */
val GlanceEntry.headLink: String
    get() = headSession?.link ?: boardLink

/** The paired server [id] among this entry's slices (row dots). */
fun GlanceEntry.serverProfile(id: String?): ServerProfile? = id?.let { wanted -> slices.firstOrNull { it.server.id == wanted }?.server }

/** The status palette entry for core:ui colours (the names match). */
val GlanceStatus.kind: StatusKind
    get() = StatusKind.valueOf(name)

/** Status word for a row: the widget vocabulary (`Allow?`, `PR`…) when it has one, else the session's own label. */
val GlanceItem.statusWord: String
    get() = badge?.word ?: statusText

/** The colour bucket of the trailing word: the badge's, else the state's. */
val GlanceItem.statusKind: StatusKind
    get() = (badge?.status ?: GlanceStatus.forState(state)).kind
