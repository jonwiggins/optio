package dev.optio.core.ui.theme

import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color

/**
 * The status palette as theme-aware colours (iOS `StatusColor`): purple = working, yellow = needs
 * input, green = completed, grey = dead / idle, red = failed. Raw ARGB values for Glance and
 * notifications are in [StatusPalette].
 */
object StatusColor {
    /** #6d28d9 — working / running (same in light and dark). */
    val purple: Color
        @Composable @ReadOnlyComposable get() = OptioTheme.colors.purple

    /** Needs input: amber in light mode, system yellow in dark mode. */
    val yellow: Color
        @Composable @ReadOnlyComposable get() = OptioTheme.colors.yellow

    /** Completed / merged / healthy. */
    val green: Color
        @Composable @ReadOnlyComposable get() = OptioTheme.colors.green

    /** Dead / exited / idle (iOS `tertiaryLabel`). */
    val grey: Color
        @Composable @ReadOnlyComposable get() = OptioTheme.colors.grey

    /** Failed / error (iOS `systemRed`). */
    val red: Color
        @Composable @ReadOnlyComposable get() = OptioTheme.colors.red
}

/**
 * Coarse state bucket for colour coding across surfaces (iOS `StatusKind`): the widgets, the Watch
 * notification and anything else that shows one dot per item. Differs from [Tone.forState] in one
 * place: `queued` / `pending` count as working here, idle there.
 */
enum class StatusKind(val label: String) {
    WORKING("working"),
    NEEDS_INPUT("needs input"),
    COMPLETED("completed"),
    FAILED("failed"),
    DEAD("stopped"),
    ;

    val color: Color
        @Composable @ReadOnlyComposable get() = color(OptioTheme.colors)

    /** [color] for an explicit palette (Canvas, previews). */
    fun color(colors: OptioColors): Color = when (this) {
        WORKING -> colors.purple
        NEEDS_INPUT -> colors.yellow
        COMPLETED -> colors.green
        FAILED -> colors.red
        DEAD -> colors.grey
    }

    /** ARGB for a light (`dark = false`) or dark surface, for Glance / notifications. */
    fun argb(dark: Boolean): Long = when (this) {
        WORKING -> StatusPalette.PURPLE
        NEEDS_INPUT -> if (dark) StatusPalette.YELLOW_DARK else StatusPalette.YELLOW_LIGHT
        COMPLETED -> if (dark) StatusPalette.GREEN_DARK else StatusPalette.GREEN_LIGHT
        FAILED -> if (dark) StatusPalette.RED_DARK else StatusPalette.RED_LIGHT
        DEAD -> if (dark) StatusPalette.GREY_DARK else StatusPalette.GREY_LIGHT
    }

    companion object {
        /**
         * The single state → colour map for tasks, jobs, runs, sessions, agents, PR reviews, local
         * terminals, pods and connections. Case-insensitive; unknown states are [DEAD].
         */
        fun forState(state: String?): StatusKind = when (state.orEmpty().lowercase()) {
            in StateSets.needsYou -> NEEDS_INPUT
            in StateSets.failed -> FAILED
            in StateSets.completed -> COMPLETED
            in StateSets.working, "queued", "pending" -> WORKING
            else -> DEAD
        }
    }
}

/**
 * The tones a piece of UI can carry (iOS `Tone`, `Core/UI/Tokens.swift`). Every state goes through
 * [forState]. [ACCENT] (yellow, "needs you") is the only tone that may draw attention on a resting
 * screen; [SUCCESS] is text only, never a fill.
 */
enum class Tone {
    /** Yellow — "needs you": attention badges and the needs-you count. */
    ACCENT,

    /** Failed, error, destructive. */
    DANGER,

    /** Completed, merged, healthy, CI passing. Text only, never a fill. */
    SUCCESS,

    /** Purple — running / provisioning / active / online. */
    WORKING,

    /** Queued / pending / idle / exited / archived. */
    IDLE,

    /** Skeletons and disabled. */
    MUTED,
    ;

    /** Concrete colour for dots, tints, meter and chart fills. */
    val color: Color
        @Composable @ReadOnlyComposable get() = color(OptioTheme.colors)

    /** Text colour for this tone (iOS `textStyle`): idle and muted fall back to label greys. */
    val textColor: Color
        @Composable @ReadOnlyComposable get() = textColor(OptioTheme.colors)

    /** [color] for an explicit palette (Canvas, previews). */
    fun color(colors: OptioColors): Color = when (this) {
        ACCENT -> colors.yellow
        DANGER -> colors.red
        SUCCESS -> colors.green
        WORKING -> colors.purple
        IDLE -> colors.grey
        MUTED -> colors.quaternaryLabel
    }

    /** [textColor] for an explicit palette. */
    fun textColor(colors: OptioColors): Color = when (this) {
        ACCENT -> colors.yellow
        DANGER -> colors.red
        SUCCESS -> colors.green
        WORKING -> colors.purple
        IDLE -> colors.tertiaryLabel
        MUTED -> colors.quaternaryLabel
    }

    /** Whether a list row shows a leading state dot for this tone (needs you, failed, working). */
    val showsDot: Boolean
        get() = this == ACCENT || this == DANGER || this == WORKING

    companion object {
        /**
         * The single state → tone map for tasks, jobs, runs, sessions, agents, PR reviews, local
         * terminals, pods and connections. Case-insensitive; unknown states (including `queued`
         * and `pending`) are [IDLE].
         */
        fun forState(state: String?): Tone = when (state.orEmpty().lowercase()) {
            in StateSets.needsYou -> ACCENT
            in StateSets.failed -> DANGER
            in StateSets.completed -> SUCCESS
            in StateSets.working -> WORKING
            else -> IDLE
        }
    }
}

/** The state vocabularies shared by [Tone.forState] and [StatusKind.forState] (iOS lists, verbatim). */
private object StateSets {
    val needsYou = setOf(
        "needs_attention", "needs_you", "stalled", "paused", "review_requested", "waiting_for_off_peak",
        "changes_requested", "request_changes", "ready", "attention", "held", "hold",
    )
    val failed = setOf(
        "failed", "error", "closed", "offline", "crashloopbackoff", "imagepullbackoff", "errimagepull",
        "notready", "failing", "unhealthy", "oom_killed", "oomkilled", "crashed", "dead", "evicted",
    )
    val completed = setOf(
        "completed", "merged", "approved", "approve", "success", "succeeded", "healthy", "passing",
        "submitted", "done", "orphan_cleaned", "ready_node", "online_host",
    )
    val working = setOf(
        "running", "active", "online", "working", "provisioning", "launching", "reviewing", "pr_opened",
        "connected", "connecting", "reconnecting", "in_progress", "processing", "live", "open", "restarted",
    )
}
