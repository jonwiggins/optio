package dev.optio.feature.widgets.model

import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.ui.theme.StatusKind
import java.time.Instant

/**
 * One session as the widgets and tiles see it: iOS `WatchItem` (Shared/WatchActivity.swift) with
 * its server fields and real [Instant]s. Every row, the small widget's head and the Needs-you
 * tile read this; the loaders build it from each server's snapshot.
 *
 * The session attributes (`when` / [where] / [who] / [then] / [statusLabel]) are optional, as on
 * the wire; the `…Value` / `…Label` accessors derive them from [kind], [title] and [mono] when a
 * row comes from an older server.
 */
data class WidgetItem(
    val kind: WatchItemKind,
    val id: String,
    /** Human title (terminal title, task title, agent name). */
    val title: String,
    /** Monospace secondary: dir basename, branch, or agent slug. */
    val mono: String,
    /** Short reason for attention, e.g. "Waiting on a permission". */
    val reason: String? = null,
    /** When the item entered its current state. */
    val since: Instant,
    /** Raw state (`needs_you`, `running`, `pr_opened`, …). */
    val state: String,
    /** Deep link, e.g. `optio://local/<id>?compose=1&server=<id>`. */
    val link: String,
    val prUrl: String? = null,
    /** Server-side "Later" window end (or the local mirror). */
    val snoozedUntil: Instant? = null,
    /** Which paired server the item lives on (`ServerProfile.id`) and its short name. */
    val serverId: String? = null,
    val serverName: String? = null,
    /** What starts it: "now", "on a trigger", "messages", a spawn source… */
    val `when`: String? = null,
    val where: WatchWhere? = null,
    /** Runtime id (`claude-code`, `codex`, …) or `terminal`. */
    val who: String? = null,
    val then: WatchThen? = null,
    /** The session row's status word ("needs you", "working", "PR open", …). */
    val statusLabel: String? = null,
) {
    /** True while a "Later" window is open at [now]. */
    fun isSnoozed(now: Instant): Boolean = snoozedUntil?.isAfter(now) == true

    // region Session chips (iOS WatchItem extension), with fallbacks for rows from older servers

    /** When chip: the wire value, else derived from the kind. */
    val whenLabel: String
        get() = `when`?.takeIf { it.isNotEmpty() } ?: if (kind == WatchItemKind.AGENT) "messages" else "now"

    val whenIcon: ChipIcon
        get() =
            when (whenLabel) {
                "now" -> ChipIcon.PLAY
                "messages" -> ChipIcon.CPU
                else -> ChipIcon.CLOCK
            }

    /** Where chip: the wire value, else the mono secondary (dir / branch / slug). */
    val whereValue: WatchWhere
        get() =
            where ?: WatchWhere(
                target = if (kind == WatchItemKind.LOCAL) WatchWhereTarget.MACHINE else WatchWhereTarget.POD,
                detail = mono.takeIf { it.isNotEmpty() },
            )

    /** Who chip: the wire runtime, else the agent named in a default terminal title. */
    val whoValue: String
        get() {
            who?.takeIf { it.isNotEmpty() }?.let { return it }
            val parts = title.split(" · ")
            if (kind == WatchItemKind.LOCAL && parts.size > 1) return parts.first()
            return if (kind == WatchItemKind.LOCAL) "terminal" else "claude-code"
        }

    val whoIsTerminal: Boolean
        get() = whoValue == "terminal"

    val whoIcon: ChipIcon
        get() = if (whoIsTerminal) ChipIcon.TERMINAL else ChipIcon.BOLT

    /** Then chip: the wire value, else derived from the kind. */
    val thenValue: WatchThen
        get() =
            then?.takeIf { it != WatchThen.UNKNOWN } ?: when (kind) {
                WatchItemKind.TASK -> WatchThen.EXITS
                WatchItemKind.AGENT -> WatchThen.WAITS_FOR_MESSAGES
                else -> WatchThen.WAITS_FOR_ME
            }

    /** Status word: the wire label, else a humanised raw state. */
    val statusText: String
        get() {
            statusLabel?.takeIf { it.isNotEmpty() }?.let { return it }
            return when (state) {
                "needs_you" -> "needs you"
                "needs_attention" -> "needs attention"
                "pr_opened" -> "PR open"
                else -> state.replace('_', ' ')
            }
        }

    // endregion

    // region Row vocabulary (iOS GlanceStyle.swift)

    /**
     * What a row is called. Default terminal titles are "<agent> · <dir>", so the leaf after the last
     * separator is the distinctive part; user titles pass through. Tasks show their branch.
     */
    val rowName: String
        get() {
            if (kind == WatchItemKind.TASK && mono.isNotEmpty()) return mono
            val last = title.split(" · ").last().trim()
            if (last.isNotEmpty()) return last
            return mono.ifEmpty { title }
        }

    /** The agent named in a default terminal title ("claude-code · web" → "claude-code"). */
    val rowAgent: String?
        get() = title.split(" · ").takeIf { it.size > 1 }?.first()

    /** Needs input or failed: the row waits on the user. */
    val waitsOnYou: Boolean
        get() = StatusKind.forState(state).let { it == StatusKind.NEEDS_INPUT || it == StatusKind.FAILED }

    /** The row's trailing symbol and word, or null for "just working". */
    val badge: RowBadge?
        get() = RowBadge.of(state, reason)

    /** Status word for a row: the widget vocabulary when it has one, else the session's own label. */
    val statusWord: String
        get() = badge?.word ?: statusText

    /** The colour bucket of the trailing word: the badge's, else the state's. */
    val statusKind: StatusKind
        get() = badge?.kind ?: StatusKind.forState(state)

    // endregion
}

/** The chip glyphs (iOS SF Symbols → the module's vector drawables). */
enum class ChipIcon { PLAY, CPU, CLOCK, LAPTOP, SERVER, TERMINAL, BOLT, EXIT }

/** Where chip icon: your machine or an Optio pod. */
val WatchWhere.icon: ChipIcon
    get() = if (target == WatchWhereTarget.MACHINE) ChipIcon.LAPTOP else ChipIcon.SERVER

/** Then chip copy (iOS `WatchThen.label`). */
val WatchThen.label: String
    get() =
        when (this) {
            WatchThen.EXITS -> "exits"
            WatchThen.WAITS_FOR_ME -> "waits for me"
            WatchThen.WAITS_FOR_MESSAGES -> "persistent"
            WatchThen.UNKNOWN -> "exits"
        }

/** Then chip icon (iOS `WatchThen.systemImage`). */
val WatchThen.icon: ChipIcon
    get() =
        when (this) {
            WatchThen.WAITS_FOR_ME -> ChipIcon.TERMINAL
            WatchThen.WAITS_FOR_MESSAGES -> ChipIcon.CPU
            else -> ChipIcon.EXIT
        }

/**
 * One symbol and one word for a row's trailing edge (iOS `RowBadge`). Null means "just working":
 * the row shows its elapsed time and nothing else.
 */
data class RowBadge(
    val symbol: Symbol,
    val word: String,
    val kind: StatusKind,
) {
    /** iOS SF Symbols, mapped to the module's drawables by the widget layer. */
    enum class Symbol { HAND, BUBBLE, ZZZ, BELL, CHECK_FILLED, ALERT_BUBBLE, MERGE, TRIANGLE, X_FILLED, X_OUTLINE, CHECK_OUTLINE, PULL, CLOCK }

    companion object {
        /**
         * Derived from the raw state plus the human reason the server already wrote, so the wire
         * contract (`WatchItem.reason`) stays untouched.
         */
        fun of(
            state: String,
            reason: String?,
        ): RowBadge? {
            val why = reason.orEmpty().lowercase()
            return when (state.lowercase()) {
                "needs_you" ->
                    when {
                        "permission" in why -> RowBadge(Symbol.HAND, "Allow?", StatusKind.NEEDS_INPUT)
                        "stopped" in why || "reply" in why || "waiting for you" in why -> RowBadge(Symbol.BUBBLE, "Reply", StatusKind.NEEDS_INPUT)
                        "quiet" in why -> RowBadge(Symbol.ZZZ, "Quiet", StatusKind.NEEDS_INPUT)
                        "bell" in why -> RowBadge(Symbol.BELL, "Bell", StatusKind.NEEDS_INPUT)
                        "finished" in why || "review" in why -> RowBadge(Symbol.CHECK_FILLED, "Review", StatusKind.NEEDS_INPUT)
                        else -> RowBadge(Symbol.ALERT_BUBBLE, "Needs you", StatusKind.NEEDS_INPUT)
                    }
                "needs_attention" ->
                    if ("conflict" in why) RowBadge(Symbol.MERGE, "Conflict", StatusKind.NEEDS_INPUT) else RowBadge(Symbol.TRIANGLE, "Stuck", StatusKind.NEEDS_INPUT)
                "failed", "error" -> RowBadge(Symbol.X_FILLED, "Failed", StatusKind.FAILED)
                "pr_opened" ->
                    when {
                        "failing" in why -> RowBadge(Symbol.X_OUTLINE, "CI", StatusKind.FAILED)
                        "approved" in why -> RowBadge(Symbol.CHECK_OUTLINE, "Approved", StatusKind.COMPLETED)
                        "passed" in why -> RowBadge(Symbol.CHECK_OUTLINE, "Review", StatusKind.COMPLETED)
                        else -> RowBadge(Symbol.PULL, "PR", StatusKind.WORKING)
                    }
                "queued", "pending" -> RowBadge(Symbol.CLOCK, "Queued", StatusKind.DEAD)
                "provisioning", "launching" -> RowBadge(Symbol.CLOCK, "Starting", StatusKind.WORKING)
                else -> null
            }
        }
    }
}
