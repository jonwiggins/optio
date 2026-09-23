package dev.optio.core.terminal

/**
 * Watches the output stream for the private DEC modes Termux's emulator parses but doesn't keep:
 *
 * - `?1003` any-event mouse tracking: a program that enables only 1003 still wants wheel reports,
 *   but Termux's `isMouseTrackingActive()` only knows 1000/1002.
 * - `?2026` synchronized output: while set, the program is mid-redraw, so the view holds its frame
 *   until the redraw ends (Claude Code wraps each repaint in it); no tearing on a slow link.
 *
 * A tiny state machine over raw bytes (`ESC [ ? Pm h|l`), resumable across chunks. Anything that
 * isn't a well-formed private mode set/reset is ignored.
 */
internal class DecModeTracker {
    var anyEventMouse: Boolean = false
        private set
    var synchronizedOutput: Boolean = false
        private set

    private var state = GROUND
    private var param = 0
    private val params = IntArray(MAX_PARAMS)
    private var count = 0

    fun reset() {
        anyEventMouse = false
        synchronizedOutput = false
        state = GROUND
    }

    fun scan(bytes: ByteArray, offset: Int, length: Int) {
        for (i in offset until offset + length) step(bytes[i].toInt() and 0xff)
    }

    private fun step(b: Int) {
        when (state) {
            GROUND -> if (b == 0x1b) state = ESC
            ESC -> state =
                when (b) {
                    '['.code -> CSI
                    'c'.code -> { // RIS: full reset.
                        anyEventMouse = false
                        synchronizedOutput = false
                        GROUND
                    }
                    0x1b -> ESC
                    else -> GROUND
                }
            CSI -> if (b == '?'.code) {
                state = PRIVATE
                param = 0
                count = 0
            } else {
                state = if (b == 0x1b) ESC else GROUND
            }
            PRIVATE ->
                when (b) {
                    in '0'.code..'9'.code -> param = (param * 10 + (b - '0'.code)).coerceAtMost(99_999)
                    ';'.code -> push()
                    'h'.code, 'l'.code -> {
                        push()
                        val set = b == 'h'.code
                        for (k in 0 until count) apply(params[k], set)
                        state = GROUND
                    }
                    0x1b -> state = ESC
                    else -> state = GROUND
                }
        }
    }

    private fun push() {
        if (count < MAX_PARAMS) params[count++] = param
        param = 0
    }

    private fun apply(mode: Int, set: Boolean) {
        when (mode) {
            1003 -> anyEventMouse = set
            2026 -> synchronizedOutput = set
        }
    }

    private companion object {
        const val GROUND = 0
        const val ESC = 1
        const val CSI = 2
        const val PRIVATE = 3
        const val MAX_PARAMS = 16
    }
}
