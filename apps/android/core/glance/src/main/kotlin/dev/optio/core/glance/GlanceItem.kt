@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.core.glance

import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.WatchItem
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchSessionSource
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers

/**
 * One row in the Watch and the widgets: a local terminal, a followed task, or an agent turn
 * (port of the iOS `WatchItem` in `Shared/WatchActivity.swift`).
 *
 * The generated wire type [WatchItem] carries Apple-reference-second dates and no server; this is
 * the app-side row, with [Instant]s and the paired server it came from ([serverId] /
 * [serverName]) so surfaces that merge several servers can label and route it. Convert with
 * [from] / [toWire]. Serializable (ISO dates) for the widget cache.
 */
@Serializable
data class GlanceItem(
    val kind: WatchItemKind,
    val id: String,
    /** Human title (terminal title, task title, agent name). */
    val title: String,
    /** Monospace secondary: dir basename, branch, or agent slug. Truncate head-first. */
    val mono: String,
    /** Short reason for attention, e.g. "Waiting on a permission", "Merge conflict". */
    val reason: String? = null,
    /** Last non-empty output line, ≤120 chars; private (lock screen: hidden). */
    val preview: String? = null,
    /** When the item entered its current state (drives the relative timer). */
    val since: Instant,
    /** Raw state (`needs_you`, `running`, `pr_opened`, …) for icon/colour mapping. */
    val state: String,
    /** Deep link, e.g. `optio://local/<id>?compose=1`. */
    val link: String,
    /** Pull request URL for followed tasks in `pr_opened` (the **Open PR** action). */
    val prUrl: String? = null,
    /** Server-side "Later" (`snoozedUntil`) or the local fallback; snoozed items sort last. */
    val snoozedUntil: Instant? = null,
    /** The paired server (`ServerProfile.id`) this item lives on. */
    val serverId: String? = null,
    /** That server's short name. */
    val serverName: String? = null,
    // Session attributes (optional, additive: the four chips of a session row).
    val source: WatchSessionSource? = null,
    /** What starts it: "now", "on a trigger", "messages", a spawn source… */
    val `when`: String? = null,
    val where: WatchWhere? = null,
    /** Runtime id (`claude-code`, `codex`, …) or `terminal`. */
    val who: String? = null,
    val then: WatchThen? = null,
    /** The session row's status word ("needs you", "working", "PR open", …). */
    val statusLabel: String? = null,
) {
    // region Session chips, with fallbacks for rows from older servers

    /** When chip: the wire value, else derived from the kind. */
    val whenLabel: String
        get() {
            val value = `when`
            if (!value.isNullOrEmpty()) return value
            return if (kind == WatchItemKind.AGENT) "messages" else "now"
        }

    /** When chip icon: play (now), cpu (messages), clock (anything else). */
    val whenIcon: GlanceIcon
        get() =
            when (whenLabel) {
                "now" -> GlanceIcon.PLAY
                "messages" -> GlanceIcon.CPU
                else -> GlanceIcon.CLOCK
            }

    /** Where chip: the wire value, else the mono secondary (dir / branch / slug). */
    val whereValue: WatchWhere
        get() =
            where ?: WatchWhere(
                target = if (kind == WatchItemKind.LOCAL) WatchWhereTarget.MACHINE else WatchWhereTarget.POD,
                detail = mono.ifEmpty { null },
            )

    /** Who chip: the wire runtime, else the agent named in a default terminal title. */
    val whoValue: String
        get() {
            val value = who
            if (!value.isNullOrEmpty()) return value
            val parts = title.split(" · ")
            if (kind == WatchItemKind.LOCAL && parts.size > 1) return parts.first()
            return if (kind == WatchItemKind.LOCAL) "terminal" else "claude-code"
        }

    val whoIsTerminal: Boolean
        get() = whoValue == "terminal"

    /** Who chip icon: a terminal, or a bolt for an agent runtime. */
    val whoIcon: GlanceIcon
        get() = if (whoIsTerminal) GlanceIcon.TERMINAL else GlanceIcon.BOLT

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
            val label = statusLabel
            if (!label.isNullOrEmpty()) return label
            return when (state) {
                "needs_you" -> "needs you"
                "needs_attention" -> "needs attention"
                "pr_opened" -> "PR open"
                else -> state.replace('_', ' ')
            }
        }

    /** True while a "Later" window is open. */
    fun isSnoozed(now: Instant = Instant.now()): Boolean = snoozedUntil?.isAfter(now) == true

    // endregion

    // region Row vocabulary (iOS `GlanceStyle.swift`)

    /**
     * What a row is called. Default terminal titles are "<agent> · <dir>", so the leaf after the
     * last separator is the distinctive part; user titles pass through; tasks use their branch.
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
        get() {
            val parts = title.split(" · ")
            return if (parts.size > 1) parts.first() else null
        }

    /** Needs input or failed: the row is waiting on the user. */
    val waitsOnYou: Boolean
        get() = GlanceStatus.forState(state).let { it == GlanceStatus.NEEDS_INPUT || it == GlanceStatus.FAILED }

    /** The row's trailing badge (one symbol, one word), or null for "just working". */
    val badge: RowBadge?
        get() = RowBadge.of(this)

    // endregion

    /** The wire row (Apple-second dates; the server fields are dropped: the wire has none). */
    fun toWire(): WatchItem =
        WatchItem(
            kind = kind,
            id = id,
            title = title,
            mono = mono,
            reason = reason,
            preview = preview,
            since = since.appleSeconds,
            state = state,
            link = link,
            prUrl = prUrl,
            snoozedUntil = snoozedUntil?.appleSeconds,
            source = source,
            `when` = `when`,
            where = where,
            who = who,
            then = then,
            statusLabel = statusLabel,
        )

    companion object {
        /** The longest [preview] a row keeps (iOS `WatchItem.init`). */
        const val PREVIEW_MAX = 120

        /** A wire row from [serverId] / [serverName] (a Watch frame, `GET /api/glance/watch`). */
        fun from(
            wire: WatchItem,
            serverId: String? = null,
            serverName: String? = null,
        ): GlanceItem =
            GlanceItem(
                kind = wire.kind,
                id = wire.id,
                title = wire.title,
                mono = wire.mono,
                reason = wire.reason,
                preview = clampPreview(wire.preview),
                since = AppleTime.toInstant(wire.since),
                state = wire.state,
                link = wire.link,
                prUrl = wire.prUrl,
                snoozedUntil = wire.snoozedUntil?.let(AppleTime::toInstant),
                serverId = serverId,
                serverName = serverName,
                source = wire.source,
                `when` = wire.`when`,
                where = wire.where,
                who = wire.who,
                then = wire.then,
                statusLabel = wire.statusLabel,
            )

        /** [preview] cut to [PREVIEW_MAX] characters. */
        fun clampPreview(preview: String?): String? = preview?.take(PREVIEW_MAX)
    }
}

/** WatchWhere chip copy: the detail, or the generic place. */
val WatchWhere.label: String
    get() = detail ?: if (target == WatchWhereTarget.POD) "Optio pod" else "machine"

/** WatchWhere chip icon: a laptop (your machine) or a server rack (an Optio pod). */
val WatchWhere.icon: GlanceIcon
    get() = if (target == WatchWhereTarget.MACHINE) GlanceIcon.LAPTOP else GlanceIcon.SERVER

/** Then chip copy: "exits" / "waits for me" / "persistent". */
val WatchThen.label: String
    get() =
        when (this) {
            WatchThen.EXITS -> "exits"
            WatchThen.WAITS_FOR_ME -> "waits for me"
            WatchThen.WAITS_FOR_MESSAGES -> "persistent"
            WatchThen.UNKNOWN -> "exits"
        }

/** Then chip icon (iOS `rectangle.portrait.and.arrow.right` / `terminal` / `cpu`). */
val WatchThen.icon: GlanceIcon
    get() =
        when (this) {
            WatchThen.WAITS_FOR_ME -> GlanceIcon.TERMINAL
            WatchThen.WAITS_FOR_MESSAGES -> GlanceIcon.CPU
            else -> GlanceIcon.EXIT
        }

/**
 * The glyphs the glanceable surfaces use, by meaning (iOS SF Symbol names in brackets). Each UI
 * maps them onto its own icon set (Material Symbols in the app and notifications).
 */
enum class GlanceIcon {
    /** When = now [play]. */
    PLAY,

    /** When = messages; Then = persistent [cpu]. */
    CPU,

    /** When = a trigger / schedule [clock]; also "Queued" / "Starting". */
    CLOCK,

    /** Where = your machine [laptopcomputer]. */
    LAPTOP,

    /** Where = an Optio pod [server.rack]. */
    SERVER,

    /** Who = terminal; Then = waits for me [terminal]. */
    TERMINAL,

    /** Who = an agent runtime [bolt]. */
    BOLT,

    /** Then = exits [rectangle.portrait.and.arrow.right]. */
    EXIT,

    /** Badge: allow a permission [hand.raised.fill]. */
    HAND,

    /** Badge: reply [bubble.left.fill]. */
    BUBBLE,

    /** Badge: gone quiet [zzz]. */
    SLEEP,

    /** Badge: terminal bell [bell.fill]. */
    BELL,

    /** Badge: review / done [checkmark.circle.fill]. */
    CHECK,

    /** Badge: needs you, generic [exclamationmark.bubble.fill]. */
    ATTENTION,

    /** Badge: merge conflict [arrow.triangle.merge]. */
    MERGE,

    /** Badge: stuck [exclamationmark.triangle.fill]. */
    WARNING,

    /** Badge: failed [xmark.circle.fill]. */
    FAILED,

    /** Badge: pull request open [arrow.triangle.pull]. */
    PULL_REQUEST,
}

/**
 * Status palette entry for a row (the names match core:ui `StatusKind`, so UI maps with
 * `StatusKind.valueOf(status.name)`): yellow needs input, purple working, green completed, red
 * failed, grey dead. [forState] is the same state → colour map as `StatusKind.forState`.
 */
enum class GlanceStatus {
    WORKING,
    NEEDS_INPUT,
    COMPLETED,
    FAILED,
    DEAD,
    ;

    companion object {
        // The same sets as iOS `Shared/StatusColor.swift` (and core:ui `StatusKind`).
        private val needsYou =
            setOf(
                "needs_attention", "needs_you", "stalled", "paused", "review_requested", "waiting_for_off_peak",
                "changes_requested", "request_changes", "ready", "attention", "held", "hold",
            )
        private val failed =
            setOf(
                "failed", "error", "closed", "offline", "crashloopbackoff", "imagepullbackoff", "errimagepull",
                "notready", "failing", "unhealthy", "oom_killed", "oomkilled", "crashed", "dead", "evicted",
            )
        private val completed =
            setOf(
                "completed", "merged", "approved", "approve", "success", "succeeded", "healthy", "passing",
                "submitted", "done", "orphan_cleaned", "ready_node", "online_host",
            )
        private val working =
            setOf(
                "running", "active", "online", "working", "provisioning", "launching", "reviewing", "pr_opened",
                "connected", "connecting", "reconnecting", "in_progress", "processing", "live", "open", "restarted",
            )

        /** Case-insensitive; queued / pending count as working; anything unknown is [DEAD]. */
        fun forState(state: String?): GlanceStatus =
            when (state.orEmpty().lowercase()) {
                in needsYou -> NEEDS_INPUT
                in failed -> FAILED
                in completed -> COMPLETED
                in working, "queued", "pending" -> WORKING
                else -> DEAD
            }
    }
}

/**
 * One symbol and one word for a row's trailing edge (iOS `RowBadge`). Null from [of] means "just
 * working": the row shows its elapsed time and nothing else. Derived from the raw state plus the
 * reason the server already wrote, so the wire contract stays untouched.
 */
data class RowBadge(
    val icon: GlanceIcon,
    val word: String,
    val status: GlanceStatus,
) {
    companion object {
        fun of(item: GlanceItem): RowBadge? {
            val reason = item.reason.orEmpty().lowercase()
            return when (item.state.lowercase()) {
                "needs_you" ->
                    when {
                        "permission" in reason -> RowBadge(GlanceIcon.HAND, "Allow?", GlanceStatus.NEEDS_INPUT)
                        "stopped" in reason || "reply" in reason || "waiting for you" in reason ->
                            RowBadge(GlanceIcon.BUBBLE, "Reply", GlanceStatus.NEEDS_INPUT)
                        "quiet" in reason -> RowBadge(GlanceIcon.SLEEP, "Quiet", GlanceStatus.NEEDS_INPUT)
                        "bell" in reason -> RowBadge(GlanceIcon.BELL, "Bell", GlanceStatus.NEEDS_INPUT)
                        "finished" in reason || "review" in reason -> RowBadge(GlanceIcon.CHECK, "Review", GlanceStatus.NEEDS_INPUT)
                        else -> RowBadge(GlanceIcon.ATTENTION, "Needs you", GlanceStatus.NEEDS_INPUT)
                    }
                "needs_attention" ->
                    if ("conflict" in reason) {
                        RowBadge(GlanceIcon.MERGE, "Conflict", GlanceStatus.NEEDS_INPUT)
                    } else {
                        RowBadge(GlanceIcon.WARNING, "Stuck", GlanceStatus.NEEDS_INPUT)
                    }
                "failed", "error" -> RowBadge(GlanceIcon.FAILED, "Failed", GlanceStatus.FAILED)
                "pr_opened" ->
                    when {
                        "failing" in reason -> RowBadge(GlanceIcon.FAILED, "CI", GlanceStatus.FAILED)
                        "approved" in reason -> RowBadge(GlanceIcon.CHECK, "Approved", GlanceStatus.COMPLETED)
                        "passed" in reason -> RowBadge(GlanceIcon.CHECK, "Review", GlanceStatus.COMPLETED)
                        else -> RowBadge(GlanceIcon.PULL_REQUEST, "PR", GlanceStatus.WORKING)
                    }
                "queued", "pending" -> RowBadge(GlanceIcon.CLOCK, "Queued", GlanceStatus.DEAD)
                "provisioning", "launching" -> RowBadge(GlanceIcon.CLOCK, "Starting", GlanceStatus.WORKING)
                else -> null
            }
        }
    }
}
