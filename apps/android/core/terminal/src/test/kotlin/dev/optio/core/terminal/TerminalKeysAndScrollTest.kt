package dev.optio.core.terminal

import android.view.KeyEvent
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/** The pure encoders and the iOS wheel arithmetic (no Android framework needed). */
class TerminalKeysAndScrollTest {
    private fun bytes(s: String) = s.toByteArray(Charsets.UTF_8)

    @Test
    fun ctrlMapsLikeATerminal() {
        assertEquals(1, TerminalKeys.ctrlCodePoint('a'.code))
        assertEquals(3, TerminalKeys.ctrlCodePoint('C'.code))
        assertEquals(26, TerminalKeys.ctrlCodePoint('z'.code))
        assertEquals(0, TerminalKeys.ctrlCodePoint(' '.code))
        assertEquals(27, TerminalKeys.ctrlCodePoint('['.code))
        assertEquals(28, TerminalKeys.ctrlCodePoint('\\'.code))
        assertEquals(29, TerminalKeys.ctrlCodePoint(']'.code))
        assertEquals(30, TerminalKeys.ctrlCodePoint('^'.code))
        assertEquals(31, TerminalKeys.ctrlCodePoint('/'.code))
        assertEquals(31, TerminalKeys.ctrlCodePoint('_'.code))
        assertEquals(127, TerminalKeys.ctrlCodePoint('8'.code))
        assertEquals('|'.code, TerminalKeys.ctrlCodePoint('|'.code)) // no control form
    }

    @Test
    fun codePointsWithModifiers() {
        assertContentEquals(bytes("\u0003"), TerminalKeys.encodeCodePoint('c'.code, ctrl = true))
        assertContentEquals(bytes("\u001bf"), TerminalKeys.encodeCodePoint('f'.code, alt = true))
        assertContentEquals(bytes("\u001b\u0017"), TerminalKeys.encodeCodePoint('w'.code, ctrl = true, alt = true))
        assertContentEquals(bytes("~"), TerminalKeys.encodeCodePoint(0x02DC)) // Bluetooth small tilde
        assertContentEquals(bytes("🚀"), TerminalKeys.encodeCodePoint(0x1F680))
        assertContentEquals(ByteArray(0), TerminalKeys.encodeCodePoint(0xD800)) // lone surrogate
    }

    @Test
    fun typedTextMapsNewlineAndAppliesLatchesToTheFirstCharacter() {
        assertContentEquals(bytes("a\rb"), TerminalKeys.encodeTyped("a\nb"))
        assertContentEquals(bytes("\u0003d"), TerminalKeys.encodeTyped("cd", ctrl = true))
        assertContentEquals(bytes("\u001bxy"), TerminalKeys.encodeTyped("xy", alt = true))
        assertContentEquals(bytes("漢🚀"), TerminalKeys.encodeTyped("漢🚀"))
    }

    @Test
    fun specialKeysFollowModifiersAndCursorMode() {
        fun special(code: Int, ctrl: Boolean = false, alt: Boolean = false, shift: Boolean = false, app: Boolean = false) =
            String(TerminalKeys.encode(TerminalKey.Special(code), ctrl, alt, shift, applicationCursor = app), Charsets.UTF_8)
        assertEquals("\u001b[A", special(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals("\u001bOA", special(KeyEvent.KEYCODE_DPAD_UP, app = true))
        assertEquals("\u001b[1;5D", special(KeyEvent.KEYCODE_DPAD_LEFT, ctrl = true))
        assertEquals("\u001b[1;3C", special(KeyEvent.KEYCODE_DPAD_RIGHT, alt = true))
        assertEquals("\u001b[1;2B", special(KeyEvent.KEYCODE_DPAD_DOWN, shift = true))
        assertEquals("\u001b[Z", special(KeyEvent.KEYCODE_TAB, shift = true))
        assertEquals("\u001b", special(KeyEvent.KEYCODE_ESCAPE))
        assertEquals("\u001b[H", special(KeyEvent.KEYCODE_MOVE_HOME))
        assertEquals("\u001b[6~", special(KeyEvent.KEYCODE_PAGE_DOWN))
        assertEquals("\u001b[15;5~", special(KeyEvent.KEYCODE_F5, ctrl = true))
        assertEquals("", special(KeyEvent.KEYCODE_A)) // not a special key
    }

    @Test
    fun bytesKeysOnlyTakeAlt() {
        val ctrlC = TerminalKey.Bytes(byteArrayOf(3))
        assertContentEquals(byteArrayOf(3), TerminalKeys.encode(ctrlC, ctrl = true))
        assertContentEquals(byteArrayOf(0x1b, 3), TerminalKeys.encode(ctrlC, alt = true))
        assertEquals(ctrlC, TerminalKey.Bytes(byteArrayOf(3)))
    }

    @Test
    fun shiftEnterIsEscCr() {
        // web conn-state.test.ts: "sends ESC CR, the sequence `claude /terminal-setup` installs"
        assertContentEquals(bytes("\u001b\r"), TerminalKeys.SHIFT_ENTER)
    }

    // region Wheel arithmetic (iOS emitWheel / startFling)

    @Test
    fun oneNotchPerCellRowOfTravelWithTheRemainderCarried() {
        val acc = RowAccumulator()
        assertEquals(0, acc.add(30f, cellHeight = 40f))
        assertEquals(1, acc.add(30f, cellHeight = 40f)) // 60 → 1 row, 20 left
        assertEquals(2, acc.add(65f, cellHeight = 40f)) // 85 → 2 rows, 5 left
        assertEquals(-1, acc.add(-50f, cellHeight = 40f)) // -45 → -1 row (toward zero), -5 left
        acc.reset()
        assertEquals(0, acc.add(39f, cellHeight = 40f))
        assertEquals(0, acc.add(10f, cellHeight = 0f))
    }

    @Test
    fun flingStartsAbove300DpPerSecondAndDecays() {
        val density = 2.625f
        assertFalse(WheelFling(300f * density, density).started)
        assertNull(WheelFling(299f * density, density).step())
        val fling = WheelFling(1000f * density, density)
        assertTrue(fling.started)
        val travel = generateSequence { fling.step() }.toList()
        assertEquals(1000f * density / 60f, travel.first(), 0.01f)
        // ×0.93 per tick until below 120 dp/s: 1000 × 0.93^n < 120 → n = 30.
        assertEquals(30, travel.size)
        assertTrue(travel.zipWithNext().all { (a, b) -> b < a })
        assertTrue(fling.finished)
    }

    @Test
    fun flingDownwardIsNegativeTravel() {
        val fling = WheelFling(-800f, 1f)
        assertTrue(fling.step()!! < 0f)
    }

    // endregion
}
