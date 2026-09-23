package dev.optio.core.glance

import dev.optio.core.data.DeepLink
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchThen
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import java.util.Locale

/**
 * Pure copy and layout decisions for the Sessions surfaces (widgets, the Watch notification, tiles)
 * (port of iOS `OptioWidgets/Widgets/GlanceCopy.swift`). Everything takes plain counts and strings.
 */
object GlanceCopy {
    // region Counts

    /**
     * "2 need you · 3 running" / "3 running" / "Quiet": the counts line and the widget header.
     * [excludingHead] counts the needs-you items beyond the head ("2 more need you · 3 running").
     */
    fun countsLine(
        needsYou: Int,
        running: Int,
        excludingHead: Boolean = false,
    ): String {
        val parts = mutableListOf<String>()
        val more = if (excludingHead) maxOf(0, needsYou - 1) else needsYou
        if (more > 0) {
            val noun =
                if (excludingHead) {
                    "more need${if (more == 1) "s" else ""} you"
                } else if (more == 1) {
                    "needs you"
                } else {
                    "need you"
                }
            parts += "$more $noun"
        }
        if (running > 0) parts += "$running running"
        if (parts.isEmpty()) return if (excludingHead) "" else "Quiet"
        return parts.joinToString(" · ")
    }

    /** The one number a small surface shows and its noun: needs-you, else running, else null ("Quiet"). */
    fun headlineCount(
        needsYou: Int,
        running: Int,
    ): Pair<Int, String>? =
        when {
            needsYou > 0 -> needsYou to if (needsYou == 1) "needs you" else "need you"
            running > 0 -> running to "running"
            else -> null
        }

    /** The Watch headline per phase, in session vocabulary. */
    fun headline(
        phase: WatchPhase,
        needsYou: Int,
        running: Int,
    ): String =
        when (phase) {
            WatchPhase.WAITING -> if (needsYou == 1) "1 session needs you" else "$needsYou sessions need you"
            WatchPhase.WORKING -> if (running == 0) "Nothing needs you" else "Nothing needs you · $running running"
            WatchPhase.OFFLINE -> "Machine unreachable"
            else -> "Sessions ended"
        }

    /** Compact trailing text: "+2" beside the head while waiting, the running count while working. */
    fun compactTrailing(
        phase: WatchPhase,
        needsYou: Int,
        running: Int,
    ): String =
        when (phase) {
            WatchPhase.WAITING -> if (needsYou > 1) "+${needsYou - 1}" else ""
            WatchPhase.WORKING -> if (running > 0) "$running" else ""
            WatchPhase.OFFLINE -> "offline"
            else -> ""
        }

    /** Working-phase secondary line: "3 sessions running" / "quiet". */
    fun workingLine(running: Int): String =
        when (running) {
            0 -> "quiet"
            1 -> "1 session running"
            else -> "$running sessions running"
        }

    /** One-line summary: "Optio · web Allow? +2" / "Optio · 3 running" / "Optio · quiet". */
    fun inline(
        prefix: String,
        headName: String?,
        headWord: String?,
        needsYou: Int,
        running: Int,
    ): String {
        if (headName != null && needsYou > 0) {
            val word = headWord ?: "needs you"
            return if (needsYou > 1) "$prefix · $headName $word +${needsYou - 1}" else "$prefix · $headName $word"
        }
        if (running > 0) return "$prefix · $running running"
        return "$prefix · quiet"
    }

    // endregion

    // region Board tiles

    /** One tile of the session board (Need you / Running / Waiting / Recurring / Agents). */
    data class Tile(
        val id: Id,
        val label: String,
        val count: Int,
    ) {
        enum class Id { NEEDS_YOU, RUNNING, WAITING, RECURRING, AGENTS }

        /** The Work view the tile opens (`optio://section/work?view=…`). */
        val view: String
            get() =
                when (id) {
                    Id.NEEDS_YOU, Id.RUNNING, Id.WAITING -> "active"
                    Id.RECURRING -> "recurring"
                    Id.AGENTS -> "agents"
                }

        /** The tile's deep link. */
        fun link(serverId: String? = null): String = DeepLink.Work(view).url(server = serverId)
    }

    /**
     * The tiles a surface can show: always Need you and Running (from its rows); the other three
     * only when the server supplied them, so an older server renders two honest tiles instead of
     * three blanks.
     */
    fun tiles(
        needsYou: Int,
        running: Int,
        waiting: Int?,
        recurring: Int?,
        agents: Int?,
    ): List<Tile> =
        buildList {
            add(Tile(Tile.Id.NEEDS_YOU, "Need you", needsYou))
            add(Tile(Tile.Id.RUNNING, "Running", running))
            if (waiting != null) add(Tile(Tile.Id.WAITING, "Waiting", waiting))
            if (recurring != null) add(Tile(Tile.Id.RECURRING, "Recurring", recurring))
            if (agents != null) add(Tile(Tile.Id.AGENTS, "Agents", agents))
        }

    // endregion

    // region Chips

    /** Who chip copy: runtime ids → short labels, `terminal` as is. */
    fun whoLabel(who: String): String =
        when (who) {
            "terminal" -> "terminal"
            "claude-code" -> "Claude Code"
            "codex" -> "Codex"
            "copilot" -> "Copilot"
            "gemini" -> "Gemini"
            "opencode" -> "OpenCode"
            "cursor" -> "Cursor"
            else -> who
        }

    /**
     * Where chip copy trimmed for a narrow row: keep the leaf of a path and the host.
     * "MacBook Pro · ~/repos/optio/apps/web" → "MacBook Pro · web" when [short].
     */
    fun whereLabel(
        detail: String?,
        target: String,
        short: Boolean,
    ): String {
        if (detail.isNullOrEmpty()) return if (target == "pod") "Optio pod" else "machine"
        if (!short) return detail
        val parts = detail.split(" · ")
        val last = parts.last()
        val leaf = last.split('/').lastOrNull { it.isNotEmpty() } ?: last
        return if (parts.size > 1) "${parts[0]} · $leaf" else leaf
    }

    // endregion
}

/**
 * Copy for the Watch (iOS `WatchCopy` in `WatchLiveActivity.swift`): headlines, the head's status
 * line, the counts line, and which actions a head gets.
 */
object WatchCopy {
    /** "2 sessions need you" / "Nothing needs you · 3 running" / "Machine unreachable" / "Sessions ended". */
    fun headline(state: GlanceWatchState): String = GlanceCopy.headline(state.phase, state.needsYouCount, state.runningCount)

    /** Short headline for narrow places: "Needs you" / "Running" / "Offline" / "Ended". */
    fun shortHeadline(state: GlanceWatchState): String =
        when (state.phase) {
            WatchPhase.WAITING -> "Needs you"
            WatchPhase.WORKING -> "Running"
            WatchPhase.OFFLINE -> "Offline"
            else -> "Ended"
        }

    /** "Machine unreachable since 10:42". */
    fun offlineLine(
        state: GlanceWatchState,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String {
        val time = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).withZone(zone).format(state.offlineSince ?: state.asOf)
        return "Machine unreachable since $time"
    }

    fun workingLine(state: GlanceWatchState): String = GlanceCopy.workingLine(state.runningCount)

    /**
     * `status · reason` under the name: "needs you · Waiting on a permission". A reason that
     * already opens with the status word ("PR #581 open · CI running" under "PR open") stands alone.
     */
    fun statusLine(item: GlanceItem): String {
        val status = item.statusText
        val reason = item.reason
        if (reason.isNullOrEmpty()) return status
        fun first(s: String) = s.lowercase().split(' ').firstOrNull { it.isNotEmpty() }.orEmpty()
        if (reason.equals(status, ignoreCase = true) || first(reason) == first(status)) return reason
        return "$status · $reason"
    }

    /** Under the head: "2 more need you · 3 running" (waiting) or "2 more running" (working); "" when redundant. */
    fun countsLine(state: GlanceWatchState): String =
        when (state.phase) {
            WatchPhase.WAITING -> GlanceCopy.countsLine(state.needsYouCount, state.runningCount, excludingHead = true)
            WatchPhase.WORKING -> if (state.runningCount > 1) "${state.runningCount - 1} more running" else ""
            else -> ""
        }

    fun summaryLine(state: GlanceWatchState): String = state.summary ?: "Sessions ended."

    /** Where a tap on the Watch goes: the head's link, else the needs-you list. */
    fun url(state: GlanceWatchState): String = state.head?.link?.takeIf { it.isNotEmpty() } ?: DeepLink.NeedsYou.url

    fun isFailedTask(item: GlanceItem): Boolean = item.kind == WatchItemKind.TASK && item.state == "failed"

    fun isAttentionTask(item: GlanceItem): Boolean = item.kind == WatchItemKind.TASK && item.state == "needs_attention"

    /** The PR to open for a followed task at an open PR (the **Open PR** action), if any. */
    fun prUrl(item: GlanceItem): String? = if (item.kind == WatchItemKind.TASK) item.prUrl?.takeIf { it.isNotEmpty() } else null

    /** "Sessions ended. 3 answered, 1 PR merged." (the final frame's summary). */
    fun endSummary(
        answered: Int,
        merged: Int,
    ): String = "Sessions ended. $answered answered, $merged PR${if (merged == 1) "" else "s"} merged."

    /** When the Watch was waiting: the reply action's title ("Message…" for a persistent agent). */
    fun replyTitle(item: GlanceItem): String = if (item.thenValue == WatchThen.WAITS_FOR_MESSAGES) "Message…" else "Reply…"

    /** Alert body when the Watch starts waiting: "claude-code · web · Waiting on a permission". */
    fun alertBody(state: GlanceWatchState): String {
        val head = state.head ?: return "A session needs you"
        return "${head.title} · ${head.reason ?: head.statusText}"
    }

    /** Timestamp helper for "as of" footers: "10:42". */
    fun time(
        instant: Instant,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
    ): String = DateTimeFormatter.ofLocalizedTime(FormatStyle.SHORT).withLocale(locale).withZone(zone).format(instant)
}
