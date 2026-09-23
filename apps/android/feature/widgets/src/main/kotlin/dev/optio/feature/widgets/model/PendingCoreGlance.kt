package dev.optio.feature.widgets.model

import java.time.Duration
import java.time.Instant

// Stand-ins for :core:glance (agent A9), used until its GlancePolicy / GlanceCopy land. Straight
// ports of apps/ios/OptioWidgets/Widgets/{GlancePolicy,GlanceCopy}.swift.

/** Pure decisions behind the widgets: cadence, staleness, snooze ordering, the Run flash. */
object GlancePolicy {
    /** How the last load went; drives cadence and the widget's honesty footer. */
    enum class Reachability { SIGNED_OUT, UNREACHABLE, LIVE }

    /** 5 min while anything runs or waits on you, 15 min when quiet, 60 min signed out / unreachable. */
    fun refreshInterval(
        reachability: Reachability,
        anyRunning: Boolean,
        anyNeedsYou: Boolean,
    ): Duration =
        when (reachability) {
            Reachability.SIGNED_OUT, Reachability.UNREACHABLE -> Duration.ofMinutes(60)
            Reachability.LIVE -> if (anyRunning || anyNeedsYou) Duration.ofMinutes(5) else Duration.ofMinutes(15)
        }

    /** Past this age the widget shows its `asOf` time instead of pretending to be live. */
    val staleAfter: Duration = Duration.ofMinutes(20)

    fun isStale(
        asOf: Instant,
        now: Instant,
    ): Boolean = Duration.between(asOf, now) > staleAfter

    /** Snoozed ("Later") items move to the back for the snooze window; order within each group is kept. */
    fun <T> applySnooze(
        items: List<T>,
        id: (T) -> String,
        snoozedUntil: Map<String, Instant>,
        now: Instant,
    ): List<T> {
        fun snoozed(item: T) = snoozedUntil[id(item)]?.isAfter(now) == true
        return items.filterNot(::snoozed) + items.filter(::snoozed)
    }

    /** The Run widget shows "Started" for this long after firing. */
    val startedFlash: Duration = Duration.ofSeconds(60)

    fun showsStarted(
        lastStartedAt: Instant?,
        now: Instant,
    ): Boolean {
        lastStartedAt ?: return false
        val age = Duration.between(lastStartedAt, now)
        return !age.isNegative && age < startedFlash
    }

    /** The Run widget's two-tap confirmation: the first tap arms it for this long. */
    val armWindow: Duration = Duration.ofSeconds(10)

    fun isArmed(
        armedAt: Instant?,
        now: Instant,
    ): Boolean {
        armedAt ?: return false
        val age = Duration.between(armedAt, now)
        return !age.isNegative && age < armWindow
    }

    /** Compact wait: "now", "4m", "2h", "3d" (never seconds). */
    fun waitText(
        since: Instant,
        now: Instant,
    ): String {
        val s = maxOf(0L, Duration.between(since, now).seconds)
        return when {
            s < 60 -> "now"
            s < 3600 -> "${s / 60}m"
            s < 86400 -> "${s / 3600}h"
            else -> "${s / 86400}d"
        }
    }
}

/** Pure copy for the Work surfaces (widgets, tiles). */
object GlanceCopy {
    /** "2 need you · 3 running" / "3 running" / "Quiet"; "2 more need you · …" under a head row. */
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
                    if (more == 1) "more needs you" else "more need you"
                } else {
                    if (more == 1) "needs you" else "need you"
                }
            parts += "$more $noun"
        }
        if (running > 0) parts += "$running running"
        if (parts.isEmpty()) return if (excludingHead) "" else "Quiet"
        return parts.joinToString(" · ")
    }

    /** The one number a small surface shows and its noun: needs-you, else running, else null ("Quiet"). */
    data class Headline(
        val count: Int,
        val noun: String,
    )

    fun headlineCount(
        needsYou: Int,
        running: Int,
    ): Headline? =
        when {
            needsYou > 0 -> Headline(needsYou, if (needsYou == 1) "needs you" else "need you")
            running > 0 -> Headline(running, "running")
            else -> null
        }

    /** One tile of the board (Need you / Running / Waiting / Recurring / Agents). */
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
    }

    /** Need you and Running always; the other three only when the server supplied them. */
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
            waiting?.let { add(Tile(Tile.Id.WAITING, "Waiting", it)) }
            recurring?.let { add(Tile(Tile.Id.RECURRING, "Recurring", it)) }
            agents?.let { add(Tile(Tile.Id.AGENTS, "Agents", it)) }
        }

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

    /** Where chip copy; `short` keeps the host and the path's leaf ("MacBook Pro · web"). */
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
}
