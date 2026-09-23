package dev.optio.core.terminal

import android.app.Activity
import android.os.Looper
import android.os.SystemClock
import android.text.InputType
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.ViewGroup
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Input encoding end to end: the soft keyboard (IME connection, per input mode), hardware keys, the
 * key bar's keys with sticky modifiers, and finger drags, which become wheel reports, scrollback or
 * arrow keys depending on what the program asked for.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class TerminalInputTest {
    private val esc = "\u001b"
    private lateinit var state: TerminalState
    private lateinit var view: OptioTerminalView

    /** Everything the terminal sent, in order; "!" marks an interaction. */
    private val events = mutableListOf<String>()
    private val sent get() = events.filter { it != "!" }

    @Before
    fun setUp() {
        state = TerminalState(TerminalGridMode.Fixed(80, 24))
        state.onInput = { events += String(it, Charsets.ISO_8859_1) }
        state.onInteraction = { events += "!" }
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        view = OptioTerminalView(activity)
        view.state = state
        activity.setContentView(view, ViewGroup.LayoutParams(1080, 2000))
        shadowOf(Looper.getMainLooper()).idle()
    }

    private fun ic(mode: TerminalInputMode, info: EditorInfo = EditorInfo()): InputConnection {
        view.inputMode = mode
        return view.onCreateInputConnection(info)
    }

    private fun utf8(s: String) = String(s.toByteArray(Charsets.UTF_8), Charsets.ISO_8859_1)

    private fun key(code: Int, meta: Int = 0): String {
        events.clear()
        val now = SystemClock.uptimeMillis()
        view.onKeyDown(code, KeyEvent(now, now, KeyEvent.ACTION_DOWN, code, 0, meta))
        return sent.joinToString("")
    }

    // region Soft keyboard

    @Test
    fun editorInfoPerInputMode() {
        val text = EditorInfo().also { ic(TerminalInputMode.Text, it) }
        assertEquals(
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
            text.inputType,
        )
        assertTrue(text.imeOptions and EditorInfo.IME_FLAG_NO_ENTER_ACTION != 0)
        assertTrue(text.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING != 0)
        assertTrue(text.imeOptions and EditorInfo.IME_FLAG_NO_FULLSCREEN != 0)
        val raw = EditorInfo().also { ic(TerminalInputMode.Raw, it) }
        assertEquals(InputType.TYPE_NULL, raw.inputType)
        val prose = EditorInfo().also { ic(TerminalInputMode.Prose, it) }
        assertTrue(prose.inputType and InputType.TYPE_TEXT_FLAG_AUTO_CORRECT != 0)
        assertTrue(prose.imeOptions and EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING == 0)
    }

    @Test
    fun committedTextIsSentAfterTheInteraction() {
        val c = ic(TerminalInputMode.Text)
        c.commitText("ls", 1)
        c.commitText("\n", 1)
        assertEquals(listOf("!", "ls", "!", "\r"), events)
    }

    @Test
    fun nonAsciiCommitsAsUtf8() {
        ic(TerminalInputMode.Text).commitText("é🚀", 1)
        assertEquals(utf8("é🚀"), sent.joinToString(""))
    }

    @Test
    fun textModeHoldsComposingTextUntilItIsCommitted() {
        val c = ic(TerminalInputMode.Text)
        c.setComposingText("かな", 1)
        assertEquals(emptyList(), sent)
        c.commitText("仮名", 1)
        assertEquals(utf8("仮名"), sent.joinToString(""))
        events.clear()
        c.setComposingText("abc", 1)
        c.finishComposingText()
        assertEquals("abc", sent.joinToString(""))
    }

    @Test
    fun proseModeSendsTheWordLiveAndCorrectsIt() {
        val c = ic(TerminalInputMode.Prose)
        for (partial in listOf("h", "he", "hel", "helo")) c.setComposingText(partial, 1)
        assertEquals("helo", sent.joinToString(""))
        events.clear()
        c.commitText("hello ", 1) // autocorrect: "helo" → "hello "
        assertEquals("\u007flo ", sent.joinToString(""))
    }

    @Test
    fun gboardRecomposesCommittedLettersToAutocorrectThem() {
        // The exact sequence Gboard sent on the emulator for "helo" + space in prose mode.
        val c = ic(TerminalInputMode.Prose)
        for (letter in listOf("h", "e", "l", "o")) c.commitText(letter, 1)
        c.beginBatchEdit()
        c.setComposingRegion(0, 4)
        c.beginBatchEdit()
        c.endBatchEdit()
        c.commitText("hello ", 1)
        c.endBatchEdit()
        assertEquals("helo\u007flo ", sent.joinToString(""))
        // Undo the autocorrect: the keyboard puts "helo " back.
        events.clear()
        c.beginBatchEdit()
        c.setComposingRegion(0, 5)
        c.commitText("helo", 1)
        c.endBatchEdit()
        assertEquals("\u007f\u007f\u007fo ", sent.joinToString(""))
    }

    @Test
    fun proseBackspaceKeyDeletesFromTheMirror() {
        val c = ic(TerminalInputMode.Prose)
        c.commitText("ab", 1)
        val now = SystemClock.uptimeMillis()
        c.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL, 0))
        c.sendKeyEvent(KeyEvent(now, now, KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL, 0))
        c.setComposingText("c", 1)
        assertEquals("ab\u007fc", sent.joinToString(""))
    }

    @Test
    fun proseLineEndsWithEnterOrAnyOtherKey() {
        val c = ic(TerminalInputMode.Prose)
        c.commitText("ls", 1)
        key(KeyEvent.KEYCODE_ENTER)
        events.clear()
        c.setComposingText("x", 1) // a new line: nothing of "ls" is erased
        assertEquals("x", sent.joinToString(""))
        state.sendKey(TerminalKeyBarKey.Left.key) // the key bar moved the cursor: the mirror starts over
        events.clear()
        c.setComposingText("y", 1)
        assertEquals("y", sent.joinToString(""))
    }

    @Test
    fun backspaceFromTheImeDeletes() {
        val c = ic(TerminalInputMode.Text)
        c.deleteSurroundingText(1, 0)
        assertEquals("\u007f", sent.joinToString(""))
        assertEquals("\u007f", key(KeyEvent.KEYCODE_DEL))
    }

    @Test
    fun proseDeletionBeforeTheLiveWordRetypesIt() {
        val c = ic(TerminalInputMode.Prose)
        c.setComposingText("wor", 1)
        events.clear()
        c.deleteSurroundingText(1, 0) // delete the space before "wor"
        assertEquals("\u007f\u007f\u007f\u007fwor", sent.joinToString(""))
    }

    @Test
    fun editorActionIsEnter() {
        ic(TerminalInputMode.Text).performEditorAction(EditorInfo.IME_ACTION_DONE)
        assertEquals("\r", sent.joinToString(""))
    }

    @Test
    fun aMultiLineCommitIsPastedBracketed() {
        state.feed("$esc[?2004h")
        ic(TerminalInputMode.Text).commitText("echo a\necho b", 1)
        assertEquals("$esc[200~echo a\recho b$esc[201~", sent.joinToString(""))
    }

    @Test
    fun latchedModifiersApplyToTheNextTypedCharacterOnce() {
        val c = ic(TerminalInputMode.Text)
        state.ctrlLatched = true
        c.commitText("c", 1)
        assertFalse(state.ctrlLatched)
        state.altLatched = true
        c.commitText("b", 1)
        assertFalse(state.altLatched)
        c.commitText("x", 1)
        assertEquals(listOf("\u0003", "${esc}b", "x"), sent)
    }

    // endregion

    // region Hardware keys

    @Test
    fun hardwareKeysEncodeLikeXterm() {
        assertEquals("a", key(KeyEvent.KEYCODE_A))
        assertEquals("A", key(KeyEvent.KEYCODE_A, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
        assertEquals("\u0001", key(KeyEvent.KEYCODE_A, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        assertEquals("${esc}b", key(KeyEvent.KEYCODE_B, KeyEvent.META_ALT_ON or KeyEvent.META_ALT_LEFT_ON))
        assertEquals("\r", key(KeyEvent.KEYCODE_ENTER))
        assertEquals("$esc\r", key(KeyEvent.KEYCODE_ENTER, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
        assertEquals("\t", key(KeyEvent.KEYCODE_TAB))
        assertEquals("$esc[Z", key(KeyEvent.KEYCODE_TAB, KeyEvent.META_SHIFT_ON or KeyEvent.META_SHIFT_LEFT_ON))
        assertEquals(esc, key(KeyEvent.KEYCODE_ESCAPE))
        assertEquals("$esc[A", key(KeyEvent.KEYCODE_DPAD_UP))
        assertEquals("$esc[1;5A", key(KeyEvent.KEYCODE_DPAD_UP, KeyEvent.META_CTRL_ON or KeyEvent.META_CTRL_LEFT_ON))
        assertEquals("${esc}OP", key(KeyEvent.KEYCODE_F1))
        assertEquals("$esc[5~", key(KeyEvent.KEYCODE_PAGE_UP))
        assertEquals("$esc[3~", key(KeyEvent.KEYCODE_FORWARD_DEL))
        state.feed("$esc[?1h") // application cursor keys
        assertEquals("${esc}OA", key(KeyEvent.KEYCODE_DPAD_UP))
    }

    @Test
    fun aHardwareKeyIsAnInteractionFirst() {
        events.clear()
        val now = SystemClock.uptimeMillis()
        view.onKeyDown(KeyEvent.KEYCODE_L, KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_L, 0))
        assertEquals(listOf("!", "l"), events)
    }

    @Test
    fun latchedCtrlAppliesToAHardwareKey() {
        state.ctrlLatched = true
        assertEquals("\u0003", key(KeyEvent.KEYCODE_C))
        assertFalse(state.ctrlLatched)
    }

    @Test
    fun systemKeysAreLeftToTheSystem() {
        val now = SystemClock.uptimeMillis()
        assertFalse(view.onKeyDown(KeyEvent.KEYCODE_VOLUME_UP, KeyEvent(now, now, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_VOLUME_UP, 0)))
        assertEquals(emptyList(), sent)
    }

    // endregion

    // region Key bar

    @Test
    fun keyBarKeysSendIosBytes() {
        fun press(k: TerminalKeyBarKey): String {
            events.clear()
            state.sendKey(k.key)
            assertEquals("!", events.first())
            return sent.joinToString("")
        }
        assertEquals(esc, press(TerminalKeyBarKey.Esc))
        assertEquals("\t", press(TerminalKeyBarKey.Tab))
        assertEquals("\u0003", press(TerminalKeyBarKey.CtrlC))
        assertEquals("\u0004", press(TerminalKeyBarKey.CtrlD))
        assertEquals("|", press(TerminalKeyBarKey.Pipe))
        assertEquals("~", press(TerminalKeyBarKey.Tilde))
        assertEquals("-", press(TerminalKeyBarKey.Dash))
        assertEquals("/", press(TerminalKeyBarKey.Slash))
        assertEquals("$esc[A", press(TerminalKeyBarKey.Up))
        assertEquals("$esc[B", press(TerminalKeyBarKey.Down))
        assertEquals("$esc[C", press(TerminalKeyBarKey.Right))
        assertEquals("$esc[D", press(TerminalKeyBarKey.Left))
        state.feed("$esc[?1h")
        assertEquals("${esc}OA", press(TerminalKeyBarKey.Up)) // iOS: ESC O x in application cursor mode
    }

    @Test
    fun keyBarStickyModifiers() {
        state.ctrlLatched = true
        state.sendKey(TerminalKeyBarKey.Up.key)
        state.ctrlLatched = true
        state.sendKey(TerminalKeyBarKey.Slash.key)
        state.altLatched = true
        state.sendKey(TerminalKeyBarKey.CtrlC.key)
        assertEquals(listOf("$esc[1;5A", "\u001f", "$esc\u0003"), sent)
        assertFalse(state.ctrlLatched || state.altLatched)
    }

    @Test
    fun theIosCtrlMenuCodes() {
        val menu = TerminalKeyBarKey.CtrlMenu.associate { (label, code) -> label to code.toInt() }
        assertEquals(mapOf("C" to 3, "D" to 4, "Z" to 26, "L" to 12, "R" to 18, "A" to 1, "E" to 5, "U" to 21, "K" to 11, "W" to 23), menu)
        for ((label, code) in menu) assertEquals(code, TerminalKeys.ctrlCodePoint(label[0].code))
    }

    // endregion

    // region Drags: wheel reports vs scrollback vs arrow keys

    private fun drag(fromY: Float, toY: Float, x: Float = 540f, steps: Int = 12) {
        val down = SystemClock.uptimeMillis()
        view.dispatchTouchEvent(MotionEvent.obtain(down, down, MotionEvent.ACTION_DOWN, x, fromY, 0))
        for (i in 1..steps) {
            val y = fromY + (toY - fromY) * i / steps
            view.dispatchTouchEvent(MotionEvent.obtain(down, down + i * 16L, MotionEvent.ACTION_MOVE, x, y, 0))
        }
        // Lift after a pause so it isn't a fling.
        view.dispatchTouchEvent(MotionEvent.obtain(down, down + steps * 16L + 500, MotionEvent.ACTION_UP, x, toY, 0))
    }

    private val rowHeight: Float get() = view.drawMetrics!!.lineHeight.toFloat()

    @Test
    fun dragWithMouseTrackingSendsSgrWheelReports() {
        state.feed("$esc[?1000h$esc[?1006h")
        events.clear()
        drag(800f, 800f + 6 * rowHeight) // finger down: older content = wheel up
        val reports = sent
        assertTrue(reports.size >= 4, "expected wheel reports, got $reports")
        assertTrue(reports.all { Regex("""\u001b\[<64;\d+;\d+M""").matches(it) }, "$reports")
        assertFalse(events.contains("!"), "scrolling is not an interaction")
        events.clear()
        drag(800f, 800f - 6 * rowHeight)
        assertTrue(sent.isNotEmpty() && sent.all { it.startsWith("$esc[<65;") }, "$sent")
    }

    @Test
    fun wheelReportsUseTheProgramsEncoding() {
        state.feed("$esc[?1000h") // X10-style encoding without 1006
        view.sendWheel(1, 5f, 5f)
        val report = sent.single()
        assertEquals("$esc[M", report.substring(0, 3))
        assertEquals(32 + 64, report[3].code)
        state.feed("$esc[?1006h")
        events.clear()
        view.sendWheel(-2, 5f, 5f)
        assertEquals(2, sent.size)
        assertTrue(sent.all { it.matches(Regex("""\u001b\[<65;\d+;\d+M""")) })
    }

    @Test
    fun dragWithoutMouseTrackingScrollsTheScrollback() {
        state.feed((1..200).joinToString("\r\n") { "line $it" })
        events.clear()
        drag(600f, 600f + 8 * rowHeight)
        assertTrue(state.topRow < 0, "scrolled back")
        assertTrue(state.scrolledBack)
        assertEquals(emptyList(), sent)
        drag(600f, 600f - 30 * rowHeight)
        assertEquals(0, state.topRow)
    }

    @Test
    fun dragOnAnAltScreenWithoutMouseSendsArrowKeys() {
        state.feed("$esc[?1049h")
        events.clear()
        drag(600f, 600f + 5 * rowHeight)
        assertTrue(sent.isNotEmpty() && sent.all { it == "$esc[A" }, "$sent")
        view.arrowKeysScrollAltScreen = false
        events.clear()
        drag(600f, 600f + 5 * rowHeight)
        assertEquals(emptyList(), sent)
    }

    @Test
    fun theDragDecision() {
        assertEquals(TerminalDragAction.WheelReports, TerminalScrollPolicy.dragAction(mouseTracking = true, altScreen = true, arrowKeysInAltScreen = true))
        assertEquals(TerminalDragAction.WheelReports, TerminalScrollPolicy.dragAction(mouseTracking = true, altScreen = false, arrowKeysInAltScreen = false))
        assertEquals(TerminalDragAction.ArrowKeys, TerminalScrollPolicy.dragAction(mouseTracking = false, altScreen = true, arrowKeysInAltScreen = true))
        assertEquals(TerminalDragAction.None, TerminalScrollPolicy.dragAction(mouseTracking = false, altScreen = true, arrowKeysInAltScreen = false))
        assertEquals(TerminalDragAction.Scrollback, TerminalScrollPolicy.dragAction(mouseTracking = false, altScreen = false, arrowKeysInAltScreen = true))
    }

    @Test
    fun aTapFocusesAndIsAnInteraction() {
        assertFalse(view.isFocused)
        val t = SystemClock.uptimeMillis()
        view.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, 300f, 300f, 0))
        view.dispatchTouchEvent(MotionEvent.obtain(t, t + 50, MotionEvent.ACTION_UP, 300f, 300f, 0))
        assertTrue(view.isFocused)
        assertTrue(state.isFocused)
        assertEquals(listOf("!"), events)
    }

    @Test
    fun aFocusRequestBeforeTheViewExistsIsKeptUntilItAttaches() {
        val early = TerminalState()
        early.focus() // e.g. a deep link's ?compose=1, before the screen composed
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val v = OptioTerminalView(activity)
        v.state = early // not attached to a window yet
        assertFalse(v.isFocused)
        activity.setContentView(v, ViewGroup.LayoutParams(1080, 2000))
        shadowOf(Looper.getMainLooper()).idle()
        assertTrue(v.isFocused)
        assertTrue(early.isFocused)
    }

    @Test
    fun aReadOnlyTerminalTakesNoInputButStillScrollsItsScrollback() {
        view.readOnly = true
        state.feed((1..200).joinToString("\r\n") { "line $it" })
        events.clear()
        val t = SystemClock.uptimeMillis()
        view.dispatchTouchEvent(MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, 300f, 300f, 0))
        view.dispatchTouchEvent(MotionEvent.obtain(t, t + 50, MotionEvent.ACTION_UP, 300f, 300f, 0))
        assertFalse(view.isFocused)
        assertFalse(view.onCheckIsTextEditor())
        drag(600f, 600f + 8 * rowHeight)
        assertTrue(state.topRow < 0, "the scrollback still scrolls")
        state.feed("$esc[?1049h$esc[?1000h$esc[?1006h") // a TUI tracking the mouse
        drag(600f, 600f + 8 * rowHeight)
        assertFalse(view.onKeyDown(KeyEvent.KEYCODE_A, KeyEvent(t, t, KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_A, 0)))
        assertEquals(emptyList(), events, "no wheel reports, keys or interactions")
    }

    @Test
    fun theViewNeverTakesFocusOnItsOwnInTouchMode() {
        assumeTrue(view.isInTouchMode)
        // The window's initial focus pass (restoreDefaultFocus) must not claim a Local grid.
        assertFalse(view.requestFocus())
        assertFalse(view.isFocused)
        assertEquals(emptyList(), events)
        state.focus()
        assertTrue(view.isFocused)
        assertEquals(listOf("!"), events)
    }

    // endregion
}
