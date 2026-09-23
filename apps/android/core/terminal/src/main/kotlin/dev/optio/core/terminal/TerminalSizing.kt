package dev.optio.core.terminal

import kotlin.math.floor

/** A PTY grid: `cols` × `rows` character cells. */
data class TerminalGrid(val cols: Int, val rows: Int) {
    override fun toString(): String = "${cols}×$rows"
}

/**
 * Pure helpers behind "the PTY follows whoever is using it": a port of iOS `TerminalSizing.swift`,
 * itself a port of the web's `components/local/sizing.ts`.
 *
 * One PTY has one grid. Viewers that interact (focus the terminal, type, tap "Use this screen")
 * claim it and size it to their own screen; viewers that are only watching render the owner's grid
 * shrunk to fit instead of fighting over the PTY. Kept free of Android types so the arithmetic is
 * unit-testable on the JVM.
 */
object TerminalSizing {
    /** The font the terminal renders at when the grid is ours (dp; iOS uses 12 pt). */
    const val BASE_FONT_DP: Double = 12.0

    /** Below this the text is a texture, not a terminal: stop shrinking. */
    const val MIN_PASSIVE_FONT_DP: Double = 5.0

    /**
     * A watched grid may grow past the base size to fill a wide screen (a tablet, or a foldable
     * unfolded), but not into a poster.
     */
    const val MAX_PASSIVE_FONT_DP: Double = 20.0

    /** Resize requests we've sent that the daemon hasn't echoed yet (oldest first). */
    const val MAX_PENDING_GRIDS: Int = 32

    /** Who owns the PTY grid, from this viewer's point of view. */
    sealed interface Mode {
        /** No one has claimed the grid yet: render at our own natural fit. */
        data object Unclaimed : Mode

        /** We asked for this grid; it's ours. */
        data object Owner : Mode

        /** Another viewer sized the PTY; we render its grid scaled to fit. */
        data class Passive(val grid: TerminalGrid) : Mode
    }

    /**
     * Font size that fits `cols` columns into `availableWidth`, given the font's cell width as a
     * fraction of its size (≈0.6 for a typical monospace; measured from the renderer when
     * available). Oversize grids shrink (down to [min]); a small grid on a wide screen grows past
     * the base so a laptop's 53 columns fill an unfolded foldable instead of a third of it (up to
     * [max]). On a phone a laptop grid lands at the base size either way.
     *
     * Unit-agnostic: pass dp to get whole dp, or pixels to get whole pixels (what the renderer
     * takes). The result is floored to a whole unit, exactly like iOS.
     */
    fun passiveFontSize(
        availableWidth: Double,
        cols: Int,
        cellWidthPerUnit: Double,
        base: Double = BASE_FONT_DP,
        min: Double = MIN_PASSIVE_FONT_DP,
        max: Double = MAX_PASSIVE_FONT_DP,
    ): Double {
        if (!(availableWidth > 0) || cols <= 0 || !(cellWidthPerUnit > 0)) return base
        val fits = floor(availableWidth / (cols * cellWidthPerUnit))
        return maxOf(min, minOf(max, fits))
    }

    /** Record a grid we just asked the daemon for. */
    fun pushSentGrid(sent: List<TerminalGrid>, grid: TerminalGrid): List<TerminalGrid> {
        val next = sent + grid
        return if (next.size > MAX_PENDING_GRIDS) next.drop(next.size - MAX_PENDING_GRIDS) else next
    }

    /**
     * The daemon echoed `grid`: if it matches one of our pending requests, that request and every
     * older one are answered (echoes arrive in order). Returns the remaining queue, or null when the
     * echo matched nothing we sent.
     */
    fun ackSentGrid(sent: List<TerminalGrid>, grid: TerminalGrid): List<TerminalGrid>? {
        val i = sent.indexOf(grid)
        return if (i < 0) null else sent.subList(i + 1, sent.size).toList()
    }

    /** The web's `sameGrid`: two grids are the same when both exist and match. */
    fun sameGrid(a: TerminalGrid?, b: TerminalGrid?): Boolean = a != null && b != null && a == b

    /**
     * Next mode when the daemon announces the PTY grid. `natural` is what a fit to our own screen
     * would produce; `sent` the grids we've asked for that haven't been echoed yet.
     *
     * Every echo of our own request is still ours, not just the latest: a claim can fit twice in
     * quick succession, so the echo of the first request lands after the second was sent.
     *
     * `recorded`: the terminal has exited and this is the grid its final screen was drawn for.
     * There is no PTY left to size, so the grid is pinned (always passive, even when it happens to
     * equal our natural fit) so a rotation can never reflow the replayed screen into something else.
     */
    fun onGridAnnounced(
        mode: Mode,
        grid: TerminalGrid,
        natural: TerminalGrid,
        sent: List<TerminalGrid>,
        recorded: Boolean = false,
    ): Mode {
        if (recorded) return Mode.Passive(grid)
        if (mode == Mode.Owner) {
            // One of our own requests echoed back: still ours. Anything else means another viewer
            // took over since.
            return if (sent.contains(grid)) Mode.Owner else Mode.Passive(grid)
        }
        // Unclaimed or already passive: if the announced grid happens to be our natural fit there's
        // nothing to scale, and no reason to show the strip.
        return if (grid == natural) Mode.Unclaimed else Mode.Passive(grid)
    }
}
