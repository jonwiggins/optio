package dev.optio.core.terminal

import com.termux.terminal.TerminalBuffer

/**
 * A text selection in emulator coordinates: columns 0 until cols, rows as Termux's buffer counts
 * them (0 until rows is the screen, negative rows are scrollback). Inclusive at both ends and kept
 * in reading order.
 */
internal class TerminalSelection {
    var active: Boolean = false
        private set
    var startCol: Int = 0
        private set
    var startRow: Int = 0
        private set
    var endCol: Int = 0
        private set
    var endRow: Int = 0
        private set

    fun set(col1: Int, row1: Int, col2: Int, row2: Int) {
        val firstIsStart = row1 < row2 || (row1 == row2 && col1 <= col2)
        if (firstIsStart) {
            startCol = col1
            startRow = row1
            endCol = col2
            endRow = row2
        } else {
            startCol = col2
            startRow = row2
            endCol = col1
            endRow = row1
        }
        active = true
    }

    fun clear() {
        active = false
    }

    /** The screen scrolled by [rows] lines (content moved up); keep the selection on its text. */
    fun shiftUp(rows: Int, oldestRow: Int) {
        if (!active || rows == 0) return
        startRow -= rows
        endRow -= rows
        if (endRow < oldestRow) clear() else if (startRow < oldestRow) {
            startRow = oldestRow
            startCol = 0
        }
    }

    fun contains(col: Int, row: Int): Boolean {
        if (!active || row < startRow || row > endRow) return false
        if (row == startRow && col < startCol) return false
        if (row == endRow && col > endCol) return false
        return true
    }

    fun text(screen: TerminalBuffer): String =
        if (!active) "" else screen.getSelectedText(startCol, startRow, endCol, endRow).trimEnd()

    companion object {
        /** Characters that end a word for long-press selection (paths and URLs stay whole). */
        private const val DELIMITERS = " \t\"'`()[]{}<>|;,"

        /**
         * The word under ([col], [row]) as an inclusive column range, or just that cell when it is
         * blank or a delimiter.
         */
        fun wordAt(screen: TerminalBuffer, col: Int, row: Int, cols: Int): IntRange {
            fun isWordCell(c: Int): Boolean {
                val cell = screen.getSelectedText(c, row, c, row)
                return cell.isNotEmpty() && cell.none { it in DELIMITERS }
            }
            if (!isWordCell(col)) return col..col
            var start = col
            while (start > 0 && isWordCell(start - 1)) start--
            var end = col
            while (end < cols - 1 && isWordCell(end + 1)) end++
            return start..end
        }
    }
}
