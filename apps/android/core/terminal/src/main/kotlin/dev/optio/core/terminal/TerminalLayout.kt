package dev.optio.core.terminal

import android.graphics.Paint
import android.graphics.Typeface
import com.termux.view.TerminalRenderer
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/** A Termux renderer at one whole-pixel text size, with the cell metrics the view lays out by. */
internal class CellMetrics(val textSize: Int, typeface: Typeface) {
    val renderer = TerminalRenderer(textSize, typeface)

    /** Advance of one cell (Termux measures "X"). */
    val cellWidth: Float = renderer.fontWidth

    /** Height of one row: `ceil(fontSpacing)`. */
    val lineHeight: Int = renderer.fontLineSpacing

    /**
     * How far down the renderer draws row 0 (Termux's `mFontLineSpacingAndAscent`, which it doesn't
     * expose). The view translates the canvas up by this much, so row `r` occupies exactly
     * `r * lineHeight until (r + 1) * lineHeight`.
     */
    val topOffset: Int

    /** Baseline offset from the top of a cell. */
    val baseline: Int

    init {
        // Measured exactly as TerminalRenderer measures (same typeface, whole-pixel size).
        val paint = Paint()
        paint.typeface = typeface
        paint.isAntiAlias = true
        paint.textSize = textSize.toFloat()
        val ascent = ceil(paint.ascent()).toInt()
        topOffset = ceil(paint.fontSpacing).toInt() + ascent
        baseline = -ascent
    }
}

/** A small LRU of [CellMetrics] by text size (Fixed grids pick sizes as the view resizes). */
internal class CellMetricsCache(private val capacity: Int = 8) {
    private val map = LinkedHashMap<Int, CellMetrics>(16, 0.75f, true)
    private var typeface: Typeface? = null

    fun get(textSize: Int, typeface: Typeface): CellMetrics {
        if (this.typeface !== typeface) {
            map.clear()
            this.typeface = typeface
        }
        val metrics = map.getOrPut(textSize) { CellMetrics(textSize, typeface) }
        while (map.size > capacity) map.remove(map.keys.first())
        return metrics
    }

    fun clear() = map.clear()
}

/** The grid arithmetic behind the two grid modes, pure over a cell-size function (unit-testable). */
internal object TerminalLayout {
    /** Cell advance (px) and row height (px) at a whole-pixel text size. */
    data class Cell(val width: Float, val height: Int)

    /** What fits `width` × `height` pixels at this cell size (at least 2 × 2; Termux's minimum). */
    fun naturalGrid(width: Float, height: Float, cell: Cell): TerminalGrid =
        TerminalGrid(
            max(TerminalState.MIN_GRID, floor(width / cell.width).toInt()),
            max(TerminalState.MIN_GRID, floor(height / cell.height).toInt()),
        )

    /**
     * The text size (px) that fits a [cols] × [rows] grid owned by someone else into the view:
     * iOS `LocalTerminalHostView`'s passive fit (the smaller of the size that fits the columns into
     * the width and the size that fits the rows into the height, so a glance shows the whole screen,
     * clamped to [minPx]…[maxPx]), then stepped down while the real metrics still overflow: hinting
     * and whole-pixel line heights aren't perfectly linear in the size. At [minPx] the grid may still
     * overflow; the view pans it then.
     */
    fun fixedTextSize(
        cols: Int,
        rows: Int,
        width: Float,
        height: Float,
        basePx: Int,
        minPx: Int,
        maxPx: Int,
        cellAt: (Int) -> Cell,
    ): Int {
        val base = cellAt(basePx)
        val byWidth =
            TerminalSizing.passiveFontSize(
                width.toDouble(), cols, base.width.toDouble() / basePx, basePx.toDouble(), minPx.toDouble(), maxPx.toDouble(),
            )
        val byHeight =
            TerminalSizing.passiveFontSize(
                height.toDouble(), rows, base.height.toDouble() / basePx, basePx.toDouble(), minPx.toDouble(), maxPx.toDouble(),
            )
        var px = min(byWidth, byHeight).toInt()
        while (px > minPx) {
            val cell = cellAt(px)
            if (cols * cell.width <= width + 0.5f && rows * cell.height <= height + 0.5f) break
            px--
        }
        return px
    }
}
