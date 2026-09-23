package dev.optio.core.terminal

import kotlin.math.abs

/**
 * What a vertical finger drag does, following what the program wants (iOS
 * `ScrollableTerminalView`):
 *
 * - The program tracks the mouse (Claude Code runs in the alternate screen with mouse tracking on
 *   and scrolls its transcript itself; `less --mouse`, `vim` with `mouse=a`, `htop`): the drag
 *   becomes mouse-wheel reports in the program's encoding, one notch per cell row of travel, as a
 *   desktop terminal does with the wheel. There is no terminal scrollback to drag through.
 * - The alternate screen without mouse tracking (`less`, `man`): arrow keys, one per row (xterm's
 *   "alternate scroll" mode, on by default in most terminals), when enabled.
 * - Otherwise the emulator's own scrollback scrolls, with fling.
 */
enum class TerminalDragAction { WheelReports, ArrowKeys, Scrollback, None }

internal object TerminalScrollPolicy {
    fun dragAction(mouseTracking: Boolean, altScreen: Boolean, arrowKeysInAltScreen: Boolean): TerminalDragAction =
        when {
            mouseTracking -> TerminalDragAction.WheelReports
            altScreen -> if (arrowKeysInAltScreen) TerminalDragAction.ArrowKeys else TerminalDragAction.None
            else -> TerminalDragAction.Scrollback
        }

    /** Wheel notches per detent of a physical mouse wheel (reports) / rows per detent (scrollback). */
    const val MOUSE_WHEEL_ROWS = 3

    // iOS fling for wheel reports: 60 Hz ticks, ×0.93 per tick, starts above 300 pt/s, ends below 120.
    const val WHEEL_FLING_HZ = 60
    const val WHEEL_FLING_DECAY = 0.93f
    const val WHEEL_FLING_START_DP_PER_S = 300f
    const val WHEEL_FLING_STOP_DP_PER_S = 120f
}

/**
 * Finger travel → whole cell rows ("notches"), carrying the remainder between moves: a port of iOS
 * `emitWheel`. Positive travel (finger moving down) pulls older content into view, i.e. wheel-up
 * reports / scrolling back, matching the direction of a native scroll.
 */
internal class RowAccumulator {
    private var remainder = 0f

    fun reset() {
        remainder = 0f
    }

    /** Adds [travel] pixels at [cellHeight] pixels per row; returns the signed whole rows to emit. */
    fun add(travel: Float, cellHeight: Float): Int {
        if (!(cellHeight > 0f)) return 0
        remainder += travel
        val rows = (remainder / cellHeight).toInt() // truncates toward zero, like Swift's Int()
        if (rows != 0) remainder -= rows * cellHeight
        return rows
    }
}

/**
 * iOS's short wheel fling: a flick keeps emitting travel at 60 Hz, decaying ×0.93 per tick, until
 * it drops below 120 dp/s. Starts only above 300 dp/s. Pure: the view drives [step] from a timer.
 */
internal class WheelFling(velocityPxPerSecond: Float, private val density: Float) {
    private var velocity = velocityPxPerSecond

    /** Whether a fling at this velocity starts at all. */
    val started: Boolean = abs(velocityPxPerSecond) / density > TerminalScrollPolicy.WHEEL_FLING_START_DP_PER_S

    var finished: Boolean = !started
        private set

    /** Travel (px) for the next 1/60 s tick, or null when the fling is over. */
    fun step(): Float? {
        if (finished) return null
        val travel = velocity / TerminalScrollPolicy.WHEEL_FLING_HZ
        velocity *= TerminalScrollPolicy.WHEEL_FLING_DECAY
        if (abs(velocity) / density < TerminalScrollPolicy.WHEEL_FLING_STOP_DP_PER_S) finished = true
        return travel
    }
}
