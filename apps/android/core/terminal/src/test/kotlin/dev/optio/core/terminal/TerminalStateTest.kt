package dev.optio.core.terminal

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.termux.terminal.TextStyle
import java.util.concurrent.TimeUnit
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/** Feeding bytes through [TerminalState]: what lands on screen, what the emulator says back, holds. */
@RunWith(AndroidJUnit4::class)
class TerminalStateTest {
    private val esc = "\u001b"

    private fun fixed(cols: Int = 40, rows: Int = 10) = TerminalState(TerminalGridMode.Fixed(cols, rows))

    private fun TerminalState.style(row: Int, col: Int): Long = emulator.screen.getStyleAt(row, col)

    private fun TerminalState.collectInput(): MutableList<String> {
        val out = mutableListOf<String>()
        onInput = { out += String(it, Charsets.UTF_8) }
        return out
    }

    private fun idle(ms: Long = 0) = shadowOf(Looper.getMainLooper()).idleFor(ms, TimeUnit.MILLISECONDS)

    @Test
    fun feedingTextDrawsItAndMovesTheCursor() {
        val s = fixed()
        s.feed("hello\r\nworld")
        assertEquals("hello", s.rowText(0))
        assertEquals("world", s.rowText(1))
        assertEquals(1, s.emulator.cursorRow)
        assertEquals(5, s.emulator.cursorCol)
        assertEquals("hello\nworld", s.screenText())
    }

    @Test
    fun utf8SplitAcrossFeedsStillDecodes() {
        val s = fixed()
        val bytes = "é漢".toByteArray(Charsets.UTF_8)
        s.feed(bytes, 0, 1)
        s.feed(bytes, 1, 3)
        s.feed(bytes, 4, bytes.size - 4)
        assertEquals("é漢", s.rowText(0))
    }

    @Test
    fun sgrColoursAndAttributesReachTheCells() {
        val s = fixed()
        s.feed("$esc[1;31mA$esc[0m$esc[38;5;141mB$esc[48;2;10;20;30mC$esc[0m$esc[4;7mD$esc[0m$esc[2;3;9mE")
        assertEquals(1, TextStyle.decodeForeColor(s.style(0, 0)))
        assertTrue(TextStyle.decodeEffect(s.style(0, 0)) and TextStyle.CHARACTER_ATTRIBUTE_BOLD != 0)
        assertEquals(141, TextStyle.decodeForeColor(s.style(0, 1)))
        assertEquals(0xFF0A141E.toInt(), TextStyle.decodeBackColor(s.style(0, 2)))
        val d = TextStyle.decodeEffect(s.style(0, 3))
        assertTrue(d and TextStyle.CHARACTER_ATTRIBUTE_UNDERLINE != 0 && d and TextStyle.CHARACTER_ATTRIBUTE_INVERSE != 0)
        val e = TextStyle.decodeEffect(s.style(0, 4))
        assertTrue(e and TextStyle.CHARACTER_ATTRIBUTE_DIM != 0)
        assertTrue(e and TextStyle.CHARACTER_ATTRIBUTE_ITALIC != 0)
        assertTrue(e and TextStyle.CHARACTER_ATTRIBUTE_STRIKETHROUGH != 0)
    }

    @Test
    fun wideCharactersTakeTwoColumns() {
        val s = fixed()
        s.feed("漢字|🚀|")
        assertEquals("漢字|🚀|", s.rowText(0))
        assertEquals("|", s.emulator.screen.getSelectedText(4, 0, 4, 0))
        assertEquals("|", s.emulator.screen.getSelectedText(7, 0, 7, 0))
        assertEquals(8, s.emulator.cursorCol)
    }

    @Test
    fun alternateScreenSwitchesAndRestores() {
        val s = fixed()
        s.feed("main")
        s.feed("$esc[?1049h")
        assertTrue(s.altScreen)
        assertEquals("", s.rowText(0))
        s.feed("${esc}[Halt")
        assertEquals("alt", s.rowText(0))
        s.feed("$esc[?1049l")
        assertFalse(s.altScreen)
        assertEquals("main", s.rowText(0))
    }

    @Test
    fun terminalModesAreObservable() {
        val s = fixed()
        s.feed("$esc[?1h")
        assertTrue(s.applicationCursor)
        s.feed("$esc[?1l$esc[?1000h")
        assertFalse(s.applicationCursor)
        assertTrue(s.mouseTracking)
        s.feed("$esc[?1000l")
        assertFalse(s.mouseTracking)
        // Termux doesn't keep 1003 (any-event tracking); our tracker does.
        s.feed("$esc[?1003h")
        assertTrue(s.mouseTracking)
        s.feed("$esc[?1003l")
        assertFalse(s.mouseTracking)
    }

    @Test
    fun titleAndBell() {
        val s = fixed()
        val titles = mutableListOf<String?>()
        var bells = 0
        s.onTitle = { titles += it }
        s.onBell = { bells++ }
        s.feed("$esc]0;build: ok\u0007")
        assertEquals("build: ok", s.title)
        assertEquals(listOf<String?>("build: ok"), titles)
        s.feed("\u0007")
        s.feed("\u0007") // within 250 ms: one buzz
        assertEquals(1, bells)
    }

    @Test
    fun theEmulatorsAnswersToQueriesGoToOnInput() {
        val s = fixed()
        val out = s.collectInput()
        s.feed("$esc[c") // DA1
        s.feed("ab$esc[6n") // DSR cursor position
        assertEquals(listOf("$esc[?64;1;2;6;9;15;18;21;22c", "$esc[1;3R"), out)
    }

    @Test
    fun feedingFromInsideACallbackWaitsForTheRunningParse() {
        val s = fixed()
        // A local echo that answers the emulator's reply while Termux is still parsing.
        s.onInput = { s.feed("<echo>") }
        s.feed("a$esc[cb")
        assertEquals("ab<echo>", s.rowText(0))
    }

    @Test
    fun heldOutputPlaysOnRelease() {
        val s = fixed()
        s.hold(timeoutMillis = 0)
        assertTrue(s.isHolding)
        s.feed("abc")
        assertEquals("", s.rowText(0))
        s.release()
        assertFalse(s.isHolding)
        assertEquals("abc", s.rowText(0))
    }

    @Test
    fun aHoldTimesOutLikeIos() {
        val s = fixed()
        s.hold() // 1.5 s, iOS's sizeHold
        s.feed("late size")
        idle(1_499)
        assertEquals("", s.rowText(0))
        idle(1)
        assertEquals("late size", s.rowText(0))
        assertFalse(s.isHolding)
    }

    @Test
    fun releaseCanDropRepliesToReplayedQueries() {
        val s = fixed()
        val out = s.collectInput()
        s.hold(0)
        s.feed("$esc[c")
        s.release(suppressReplies = true)
        assertEquals(emptyList(), out)
        s.feed("$esc[c") // live: answered
        assertEquals(1, out.size)
    }

    @Test
    fun replayedOutputNeverRingsOrWritesTheClipboard() {
        val s = fixed()
        var bells = 0
        val copies = mutableListOf<String>()
        s.onBell = { bells++ }
        s.onClipboardCopy = { copies += it }
        s.hold(0)
        s.feed("\u0007$esc]52;c;aGVsbG8=\u0007") // "hello"
        s.release()
        assertEquals(0, bells)
        assertEquals(emptyList(), copies)
        s.feed("$esc]52;c;aGVsbG8=\u0007")
        assertEquals(listOf("hello"), copies)
    }

    @Test
    fun fitModeHoldsOutputUntilTheGridIsKnown() {
        val s = TerminalState()
        val sizes = mutableListOf<TerminalGrid>()
        s.onGridSizeChanged = { sizes += it }
        s.feed("hello")
        assertEquals("", s.rowText(0))
        s.onViewLaidOut(TerminalGrid(57, 44))
        assertEquals(TerminalGrid(57, 44), s.grid)
        assertEquals("hello", s.rowText(0))
        assertEquals(listOf(TerminalGrid(57, 44)), sizes)
    }

    @Test
    fun fitReportsTheFirstLayoutAndThenOnlyChanges() {
        val s = TerminalState()
        val sizes = mutableListOf<TerminalGrid>()
        s.onGridSizeChanged = { sizes += it }
        s.onViewLaidOut(TerminalGrid(80, 24)) // equal to the initial emulator grid: still reported
        s.onViewLaidOut(TerminalGrid(80, 24))
        s.onViewLaidOut(TerminalGrid(80, 11)) // the keyboard came up
        assertEquals(listOf(TerminalGrid(80, 24), TerminalGrid(80, 11)), sizes)
    }

    @Test
    fun fixedModeRendersTheOwnersGridAndNeverReports() {
        val s = TerminalState(TerminalGridMode.Fixed(160, 45))
        var reports = 0
        s.onGridSizeChanged = { reports++ }
        s.feed("x") // the grid is known: no layout wait
        assertEquals("x", s.rowText(0))
        s.onViewLaidOut(TerminalGrid(57, 44))
        assertEquals(TerminalGrid(160, 45), s.grid)
        assertEquals(TerminalGrid(57, 44), s.naturalGrid)
        assertEquals(0, reports)
    }

    @Test
    fun switchingToFitResizesImmediatelyAndReports() {
        val s = TerminalState(TerminalGridMode.Fixed(160, 45))
        s.onViewLaidOut(TerminalGrid(57, 44))
        val sizes = mutableListOf<TerminalGrid>()
        s.onGridSizeChanged = { sizes += it }
        s.gridMode = TerminalGridMode.Fit // a claim
        assertEquals(TerminalGrid(57, 44), s.grid)
        assertEquals(listOf(TerminalGrid(57, 44)), sizes)
        s.gridMode = TerminalGridMode.Fixed(120, 32) // another viewer took it
        assertEquals(TerminalGrid(120, 32), s.grid)
        assertEquals(1, sizes.size)
    }

    @Test
    fun fixedGridsAreClampedToWhatTermuxAccepts() {
        val s = TerminalState(TerminalGridMode.Fixed(1, 0))
        assertEquals(TerminalGrid(2, 2), s.grid)
        s.gridMode = TerminalGridMode.Fixed(5000, 3)
        assertEquals(TerminalGrid(1000, 3), s.grid)
    }

    @Test
    fun naturalGridChangesAreReported() {
        val s = TerminalState(TerminalGridMode.Fixed(160, 45))
        val natural = mutableListOf<TerminalGrid>()
        s.onNaturalGridChanged = { natural += it }
        s.onViewLaidOut(TerminalGrid(57, 44))
        s.onViewLaidOut(TerminalGrid(57, 44))
        s.onViewLaidOut(TerminalGrid(99, 20))
        assertEquals(listOf(TerminalGrid(57, 44), TerminalGrid(99, 20)), natural)
    }

    @Test
    fun aConsumerCanGoFixedOnFirstLayoutBeforeHeldBytesLand() {
        // Local: the size frame arrived before the view laid out; on settle the stream re-judges and
        // the replay must land on the announced grid, not the natural one.
        val s = TerminalState()
        s.onNaturalGridChanged = { s.gridMode = TerminalGridMode.Fixed(30, 5) }
        s.feed("x".repeat(40))
        s.onViewLaidOut(TerminalGrid(57, 44))
        assertEquals(TerminalGrid(30, 5), s.grid)
        assertEquals("x".repeat(30), s.rowText(0))
        assertEquals("x".repeat(10), s.rowText(1))
    }

    @Test
    fun scrolledBackStaysOnItsLinesWhileOutputArrives() {
        val s = fixed(cols = 20, rows = 5)
        s.feed((1..30).joinToString("\r\n") { "line $it" })
        assertEquals(0, s.topRow)
        assertFalse(s.scrolledBack)
        s.scrollBy(-3)
        assertTrue(s.scrolledBack)
        val top = s.rowText(s.topRow)
        s.feed("\r\nline 31\r\nline 32")
        assertEquals(top, s.rowText(s.topRow))
        s.scrollToBottom()
        assertFalse(s.scrolledBack)
        assertEquals("line 32", s.rowText(4))
    }

    @Test
    fun atTheBottomNewOutputIsFollowed() {
        val s = fixed(cols = 20, rows = 5)
        s.feed((1..30).joinToString("\r\n") { "line $it" })
        s.feed("\r\nline 31")
        assertEquals(0, s.topRow)
        assertEquals("line 31", s.rowText(4))
    }

    @Test
    fun typingJumpsBackToTheBottom() {
        val s = fixed(cols = 20, rows = 5)
        s.feed((1..30).joinToString("\r\n") { "line $it" })
        s.scrollBy(-10)
        s.sendText("x")
        assertEquals(0, s.topRow)
    }

    @Test
    fun resetClearsScreenScrollbackModesAndTitle() {
        val s = fixed(cols = 20, rows = 5)
        val titles = mutableListOf<String?>()
        s.onTitle = { titles += it }
        s.feed("$esc]2;t\u0007$esc[?1h")
        s.feed((1..30).joinToString("\r\n") { "line $it" })
        s.hold(0)
        s.feed("pending")
        s.reset()
        assertEquals("", s.rowText(0))
        assertEquals(0, s.emulator.screen.activeTranscriptRows)
        assertFalse(s.applicationCursor)
        assertNull(s.title)
        assertEquals(listOf("t", null), titles)
        s.release()
        assertEquals("", s.rowText(0)) // pending bytes were dropped with the old screen
    }

    @Test
    fun selectionCopiesItsText() {
        val s = fixed()
        s.feed("hello world\r\nsecond line")
        s.select(6, 0, 10, 0)
        assertTrue(s.hasSelection)
        assertEquals("world", s.selectedText())
        s.select(6, 0, 5, 1)
        assertEquals("world\nsecond", s.selectedText())
        s.selectAll()
        assertEquals("hello world\nsecond line", s.selectedText())
        s.clearSelection()
        assertFalse(s.hasSelection)
        assertNull(s.selectedText())
    }

    @Test
    fun wordSelectionKeepsPathsWhole() {
        val s = fixed(cols = 60)
        s.feed("open apps/web/src/lib.ts now")
        val word = TerminalSelection.wordAt(s.emulator.screen, 8, 0, s.emulator.mColumns)
        assertEquals(5..23, word)
    }

    @Test
    fun feedFromAnotherThreadHopsToMain() {
        val s = fixed()
        val t = Thread { s.feed("from okhttp") }
        t.start()
        t.join()
        assertEquals("", s.rowText(0))
        idle()
        assertEquals("from okhttp", s.rowText(0))
    }

    @Test
    fun pendingOutputIsBoundedWhenNoViewEverLaysOut() {
        val s = TerminalState() // Fit, never laid out
        val chunk = ByteArray(64 * 1024) { 'a'.code.toByte() }
        repeat(33) { s.feed(chunk) } // > 2 MiB
        assertEquals("a".repeat(80), s.rowText(0))
    }
}
