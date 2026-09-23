package dev.optio.core.terminal

import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

class DecModeTrackerTest {
    private fun DecModeTracker.feed(s: String) {
        val b = s.toByteArray()
        scan(b, 0, b.size)
    }

    @Test
    fun tracksSynchronizedOutputAcrossChunks() {
        val t = DecModeTracker()
        t.feed("hello \u001b[?20")
        assertFalse(t.synchronizedOutput)
        t.feed("26hredraw")
        assertTrue(t.synchronizedOutput)
        t.feed("\u001b[?2026l")
        assertFalse(t.synchronizedOutput)
    }

    @Test
    fun readsEveryParameterOfACombinedSequence() {
        val t = DecModeTracker()
        t.feed("\u001b[?1000;1003;1006h")
        assertTrue(t.anyEventMouse)
        t.feed("\u001b[?1003l")
        assertFalse(t.anyEventMouse)
    }

    @Test
    fun ignoresNonPrivateAndMalformedSequences() {
        val t = DecModeTracker()
        t.feed("\u001b[2026h") // not private
        t.feed("\u001b[?20x26h") // broken
        t.feed("\u001b]0;?2026h\u0007") // inside an OSC-ish string
        assertFalse(t.synchronizedOutput)
    }

    @Test
    fun anEscapeRestartsParsing() {
        val t = DecModeTracker()
        t.feed("\u001b[?20\u001b[?2026h")
        assertTrue(t.synchronizedOutput)
    }

    @Test
    fun fullResetClearsModes() {
        val t = DecModeTracker()
        t.feed("\u001b[?1003h\u001b[?2026h")
        t.feed("\u001bc")
        assertFalse(t.anyEventMouse)
        assertFalse(t.synchronizedOutput)
    }
}
