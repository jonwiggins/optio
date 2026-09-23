package dev.optio.core.terminal

import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TerminalOutput
import com.termux.terminal.TerminalSession
import com.termux.terminal.TerminalSessionClient
import java.io.ByteArrayOutputStream

/**
 * One terminal: a Termux [TerminalEmulator] plus everything a screen needs to drive it. Create it
 * where the stream lives (a ViewModel, or `remember` in a screen) and show it with
 * [TerminalSurface] (Compose) or [OptioTerminalView]. The emulator, its scrollback and any held
 * bytes live here, not in the view, so a rotation or a Transcript ⇄ Screen switch keeps the screen.
 *
 * Data in: [feed] (and [reset]). Data out: [onInput] carries every byte meant for the PTY. The
 * other callbacks and the observable properties (Compose snapshot state) report what the terminal
 * and the user are doing.
 *
 * Threading: use it on the main thread. [feed] may be called from any thread (it hops to main);
 * callbacks always fire on main.
 */
@Stable
class TerminalState(
    gridMode: TerminalGridMode = TerminalGridMode.Fit,
    /** Lines of scrollback kept above the screen (Termux accepts 100–50 000). */
    val scrollbackRows: Int = DEFAULT_SCROLLBACK_ROWS,
) {
    // region Callbacks

    /**
     * Bytes for the PTY: typed text and keys, pastes, key-bar keys, mouse-wheel reports, arrow keys
     * from scrolling an alternate screen, and the emulator's own answers to the program's queries
     * (device attributes, cursor position, colours). Only some of these are the user acting on the
     * terminal; [onInteraction] marks those.
     */
    var onInput: ((ByteArray) -> Unit)? = null

    /**
     * [TerminalGridMode.Fit]: the terminal now lays out at this grid (first layout, rotation, the
     * keyboard, a switch back to Fit). The owner of the PTY sends a resize; a Local viewer that hasn't
     * claimed the grid ignores it. Never fires in [TerminalGridMode.Fixed].
     */
    var onGridSizeChanged: ((TerminalGrid) -> Unit)? = null

    /**
     * What a fit to the view would produce at the base font became known or changed (first layout,
     * rotation, keyboard). Local re-judges an announced grid here (iOS `TerminalBridge.onSettled`).
     */
    var onNaturalGridChanged: ((TerminalGrid) -> Unit)? = null

    /**
     * An explicit "I'm using this screen": a tap on the terminal, it taking focus, a key (hardware,
     * soft keyboard or key bar), a paste. Fires before the input it causes, so a Local viewer can
     * claim the grid and resize the PTY before the program sees the keystroke. Never fires for the
     * emulator's replies, scrolling, or text selection.
     */
    var onInteraction: (() -> Unit)? = null

    /** BEL, at most one per 250 ms and never from replayed output. Null: a haptic tick. */
    var onBell: (() -> Unit)? = null

    /** The program set the window title (`OSC 0/2`); null after [reset]. */
    var onTitle: ((String?) -> Unit)? = null

    /**
     * The program asked to copy text (`OSC 52`), never from replayed output. Null: the view puts it
     * on the system clipboard.
     */
    var onClipboardCopy: ((String) -> Unit)? = null

    // endregion

    // region Observable state

    private var gridModeValue by mutableStateOf(sanitize(gridMode))

    /**
     * Fit to the view, or render a grid someone else owns ([TerminalGridMode.Fixed]). Switching to
     * Fixed resizes the emulator at once; switching to Fit resizes it to [naturalGrid] at once when
     * that is known (so [grid] is right straight after the assignment) and reports it through
     * [onGridSizeChanged].
     */
    var gridMode: TerminalGridMode
        get() = gridModeValue
        set(value) = changeGridMode(value)

    /** The emulator's current cols × rows. In Fit mode 80×24 until a view has laid out. */
    var grid: TerminalGrid by mutableStateOf(initialGrid(gridModeValue))
        private set

    /** What a fit to the attached view produces at the base font; null until a view has laid out. */
    var naturalGrid: TerminalGrid? by mutableStateOf(null)
        private set

    /** The title the program set, if any. */
    var title: String? by mutableStateOf(null)
        private set

    /** Application cursor mode (DECCKM): arrows send `ESC O x` instead of `ESC [ x`. */
    var applicationCursor: Boolean by mutableStateOf(false)
        private set

    /** The program tracks the mouse: a vertical drag sends wheel reports instead of scrolling. */
    var mouseTracking: Boolean by mutableStateOf(false)
        private set

    /** The alternate screen is up (full-screen programs); there is no scrollback on it. */
    var altScreen: Boolean by mutableStateOf(false)
        private set

    /** The user scrolled up into the scrollback; new output no longer follows the bottom. */
    var scrolledBack: Boolean by mutableStateOf(false)
        private set

    /** The terminal view has input focus (the keyboard, hardware or soft, types into it). */
    var isFocused: Boolean by mutableStateOf(false)
        internal set

    /** Sticky Ctrl from the key bar: applies to the next key, then releases. */
    var ctrlLatched: Boolean by mutableStateOf(false)

    /** Sticky Alt from the key bar: the next key gets an ESC prefix, then it releases. */
    var altLatched: Boolean by mutableStateOf(false)

    /** Output is being held (see [hold]). */
    var isHolding: Boolean by mutableStateOf(false)
        private set

    /** Some text is selected. */
    var hasSelection: Boolean by mutableStateOf(false)
        private set

    // endregion

    private val mainHandler by lazy { Handler(Looper.getMainLooper()) }
    private val output = Output()
    private val client = QuietClient()
    internal val decModes = DecModeTracker()
    internal val selection = TerminalSelection()
    internal val keyEncoder = HardwareKeyEncoder()

    internal var emulator: TerminalEmulator = newEmulator(grid)
        private set

    /** First buffer row on screen: 0 at the bottom, negative when scrolled back. */
    internal var topRow: Int = 0
        private set

    internal var view: OptioTerminalView? = null
        private set

    private var themeDark: Boolean? = null
    private val pending = ByteArrayOutputStream()
    private val reentrant = ByteArrayOutputStream()
    private var appending = false
    private var holdTimeout: Runnable? = null
    private var suppressReplies = false
    private var replaying = false
    private var lastBellAt = Long.MIN_VALUE / 2
    private var reportedFit = false
    private var focusPending = false

    private val waitingForLayout: Boolean get() = gridModeValue == TerminalGridMode.Fit && naturalGrid == null
    private val buffering: Boolean get() = isHolding || waitingForLayout

    // region Data

    /**
     * Terminal output (raw PTY bytes) for the screen. While output is held ([hold]), or in Fit mode
     * before any view has laid out (the grid isn't known yet), bytes are buffered and replayed in
     * order when that ends: the emulator can't un-draw a screen painted at the wrong grid. Safe from
     * any thread.
     */
    fun feed(bytes: ByteArray, offset: Int = 0, length: Int = bytes.size - offset) {
        require(offset >= 0 && length >= 0 && offset + length <= bytes.size) { "offset/length out of range" }
        if (length == 0) return
        if (!isMainThread()) {
            val copy = bytes.copyOfRange(offset, offset + length)
            mainHandler.post { feed(copy) }
            return
        }
        if (buffering) {
            pending.write(bytes, offset, length)
            // Never let a view that never lays out hold unbounded output: play it at the grid we have.
            if (pending.size() > MAX_PENDING_BYTES) flushPending(force = true)
            return
        }
        appendOutput(bytes, offset, length)
    }

    /** [feed] for text (UTF-8). */
    fun feed(text: String) = feed(text.toByteArray(Charsets.UTF_8))

    /**
     * Back to a blank terminal at the current grid: a fresh emulator (screen, scrollback, modes,
     * title), no selection, and nothing pending. The hold state is kept. Local calls this on the
     * first bytes of a reconnect's replay, never before, so a reconnect that brings nothing back
     * can't blank the screen.
     */
    fun reset() {
        checkMainThread()
        pending.reset()
        emulator = newEmulator(grid)
        themeDark?.let { TerminalTheme.apply(emulator, it) }
        decModes.reset()
        keyEncoder.reset()
        selection.clear()
        topRow = 0
        if (title != null) {
            title = null
            onTitle?.invoke(null)
        }
        syncModes()
        view?.onEmulatorReplaced()
    }

    /**
     * Holds output until [release] (or [timeoutMillis]; 0 waits for [release]). Local holds each
     * connection's scrollback replay until the daemon's `size` frame, so the replay lands on the
     * grid it was drawn for.
     */
    fun hold(timeoutMillis: Long = DEFAULT_HOLD_MILLIS) {
        checkMainThread()
        isHolding = true
        cancelHoldTimeout()
        if (timeoutMillis > 0) {
            val r = Runnable {
                holdTimeout = null
                release()
            }
            holdTimeout = r
            mainHandler.postDelayed(r, timeoutMillis)
        }
    }

    /**
     * Plays the held output. Replayed output never rings the bell or writes the clipboard;
     * [suppressReplies] also drops the emulator's answers to queries inside it (a replayed
     * `ESC [ c` would otherwise answer a program that asked long ago, typing the answer into
     * whatever runs now).
     */
    fun release(suppressReplies: Boolean = false) {
        checkMainThread()
        cancelHoldTimeout()
        if (!isHolding) return
        isHolding = false
        flushPending(suppressReplies = suppressReplies)
    }

    // endregion

    // region Input

    /**
     * Sends a key as the key bar does: the latched modifiers apply (then release), arrows follow
     * the application cursor mode, and [onInteraction] fires first.
     */
    fun sendKey(key: TerminalKey) {
        checkMainThread()
        val e = emulator
        val bytes =
            TerminalKeys.encode(
                key,
                ctrl = ctrlLatched,
                alt = altLatched,
                applicationCursor = e.isCursorKeysApplicationMode,
                applicationKeypad = e.isKeypadApplicationMode,
            )
        consumeLatches()
        userInput(bytes)
    }

    /** Types [text] as the keyboard would (`\n` → CR; a latched modifier applies to the first character). */
    fun sendText(text: String) {
        checkMainThread()
        val bytes = TerminalKeys.encodeTyped(text, ctrl = ctrlLatched, alt = altLatched)
        consumeLatches()
        userInput(bytes)
    }

    /**
     * Pastes [text]: escapes and C1 controls are stripped, newlines become CR, and it is bracketed
     * (`ESC [ 200 ~` … `ESC [ 201 ~`) when the program asked for bracketed paste.
     */
    fun paste(text: String) {
        checkMainThread()
        if (text.isEmpty()) return
        beginUserInput()
        emulator.paste(text)
    }

    /** Takes input focus and shows the soft keyboard (as soon as a view is attached). */
    fun focus() {
        checkMainThread()
        val v = view
        if (v != null && v.isAttachedToWindow) v.requestTerminalFocus(showKeyboard = true) else focusPending = true
    }

    /** Hides the soft keyboard and gives up input focus. */
    fun blur() {
        checkMainThread()
        focusPending = false
        view?.releaseTerminalFocus()
    }

    // endregion

    // region Scrolling and selection

    /** Back to the bottom (the live screen). */
    fun scrollToBottom() {
        if (topRow == 0) return
        topRow = 0
        syncModes()
        view?.invalidate()
    }

    /** Selects the whole buffer: scrollback and screen. */
    fun selectAll() {
        checkMainThread()
        val e = emulator
        selection.set(0, -e.screen.activeTranscriptRows, e.mColumns - 1, e.mRows - 1)
        onSelectionChanged()
    }

    /** The selected text (trailing blanks trimmed), or null when nothing is selected. */
    fun selectedText(): String? = if (selection.active) selection.text(emulator.screen) else null

    fun clearSelection() {
        if (!selection.active) return
        selection.clear()
        onSelectionChanged()
    }

    /** The screen's text (not the scrollback), soft-wrapped lines joined, trailing blanks trimmed. */
    fun screenText(): String = emulator.screen.getSelectedText(0, 0, emulator.mColumns - 1, emulator.mRows - 1).trimEnd()

    /** Scrollback and screen as text. */
    fun transcriptText(): String = emulator.screen.transcriptText

    /** The rows currently on screen, including scrollback when scrolled up (for accessibility). */
    internal fun visibleText(): String =
        emulator.screen.getSelectedText(0, topRow, emulator.mColumns - 1, topRow + emulator.mRows - 1).trimEnd()

    /** One buffer row's text, trailing blanks trimmed (tests). */
    internal fun rowText(row: Int): String = emulator.screen.getSelectedText(0, row, emulator.mColumns - 1, row, false).trimEnd()

    /** Stops timers and detaches the view. The state must not be used afterwards. */
    fun dispose() {
        cancelHoldTimeout()
        view?.state = null
    }

    // endregion

    // region Internal: view link

    internal fun attachView(v: OptioTerminalView) {
        val old = view
        if (old != null && old !== v) old.state = null
        view = v
    }

    internal fun detachView(v: OptioTerminalView) {
        if (view === v) {
            view = null
            if (isFocused) isFocused = false
        }
    }

    internal fun takeFocusRequest(): Boolean = focusPending.also { focusPending = false }

    internal fun applyTheme(dark: Boolean) {
        if (themeDark == dark) return
        themeDark = dark
        TerminalTheme.apply(emulator, dark)
        view?.invalidate()
    }

    /** The view laid out: [natural] is what a fit to it produces at the base font. */
    internal fun onViewLaidOut(natural: TerminalGrid) {
        val changed = natural != naturalGrid
        if (changed) naturalGrid = natural
        if (gridModeValue == TerminalGridMode.Fit) fitTo(natural)
        if (changed) onNaturalGridChanged?.invoke(natural)
        flushPending()
    }

    internal fun notifyInteraction() {
        onInteraction?.invoke()
    }

    /** User-originated bytes: interaction first, then back to the bottom, then the PTY. */
    internal fun userInput(bytes: ByteArray) {
        if (bytes.isEmpty()) return
        beginUserInput()
        onInput?.invoke(bytes)
    }

    /** Bytes the terminal sends on the user's behalf that are not an interaction (wheel, scroll arrows). */
    internal fun programInput(bytes: ByteArray) {
        if (bytes.isNotEmpty()) onInput?.invoke(bytes)
    }

    internal fun consumeLatches() {
        if (ctrlLatched) ctrlLatched = false
        if (altLatched) altLatched = false
    }

    internal fun scrollBy(rows: Int) {
        val oldest = -emulator.screen.activeTranscriptRows
        val next = (topRow + rows).coerceIn(oldest, 0)
        if (next == topRow) return
        topRow = next
        syncModes()
        view?.invalidate()
    }

    internal fun select(col1: Int, row1: Int, col2: Int, row2: Int) {
        selection.set(col1, row1, col2, row2)
        onSelectionChanged()
    }

    // endregion

    // region Internal: output

    private fun beginUserInput() {
        notifyInteraction()
        clearSelection()
        scrollToBottom()
        view?.onUserInput()
    }

    private fun appendOutput(bytes: ByteArray, offset: Int, length: Int) {
        // A consumer may feed from inside a callback the emulator fires mid-parse (onInput for a
        // reply, a local echo): queue it and let the running append finish first.
        if (appending) {
            reentrant.write(bytes, offset, length)
            return
        }
        appending = true
        try {
            decModes.scan(bytes, offset, length)
            // Termux's append reads from index 0.
            val chunk = if (offset == 0) bytes else bytes.copyOfRange(offset, offset + length)
            emulator.append(chunk, length)
            while (reentrant.size() > 0) {
                val more = reentrant.toByteArray()
                reentrant.reset()
                decModes.scan(more, 0, more.size)
                emulator.append(more, more.size)
            }
        } finally {
            appending = false
        }
        afterOutput()
    }

    private fun afterOutput() {
        val e = emulator
        val shift = e.scrollCounter
        e.clearScrollCounter()
        val oldest = -e.screen.activeTranscriptRows
        when {
            e.isAlternateBufferActive -> topRow = 0
            // Scrolled back: keep the lines the user is reading in place while output scrolls.
            topRow < 0 && shift > 0 -> topRow -= shift
        }
        topRow = topRow.coerceIn(oldest, 0)
        if (shift > 0) selection.shiftUp(shift, oldest)
        syncModes()
        view?.onScreenUpdated(synchronized = decModes.synchronizedOutput)
    }

    private fun flushPending(suppressReplies: Boolean = false, force: Boolean = false) {
        if (pending.size() == 0 || (!force && buffering)) return
        val bytes = pending.toByteArray()
        pending.reset()
        replaying = true
        this.suppressReplies = suppressReplies
        try {
            appendOutput(bytes, 0, bytes.size)
        } finally {
            replaying = false
            this.suppressReplies = false
        }
    }

    private fun changeGridMode(value: TerminalGridMode) {
        checkMainThread()
        val mode = sanitize(value)
        if (mode == gridModeValue) return
        gridModeValue = mode
        when (mode) {
            is TerminalGridMode.Fixed -> resizeEmulator(mode.grid)
            TerminalGridMode.Fit -> naturalGrid?.let { fitTo(it) }
        }
        view?.onGridModeChanged()
        flushPending()
    }

    private fun fitTo(natural: TerminalGrid) {
        val changed = resizeEmulator(natural)
        if (changed || !reportedFit) {
            reportedFit = true
            onGridSizeChanged?.invoke(grid)
        }
    }

    /** Resizes the emulator (Termux reflows soft-wrapped lines); true when the grid changed. */
    private fun resizeEmulator(target: TerminalGrid): Boolean {
        val e = emulator
        if (e.mColumns == target.cols && e.mRows == target.rows) {
            if (grid != target) grid = target
            return false
        }
        e.resize(target.cols, target.rows)
        grid = target
        selection.clear()
        topRow = topRow.coerceIn(-e.screen.activeTranscriptRows, 0)
        syncModes()
        view?.invalidate()
        return true
    }

    private fun onSelectionChanged() {
        syncModes()
        view?.onSelectionChanged()
    }

    private fun syncModes() {
        val e = emulator
        val appCursor = e.isCursorKeysApplicationMode
        if (appCursor != applicationCursor) applicationCursor = appCursor
        val mouse = e.isMouseTrackingActive || decModes.anyEventMouse
        if (mouse != mouseTracking) mouseTracking = mouse
        val alt = e.isAlternateBufferActive
        if (alt != altScreen) {
            altScreen = alt
            // The selection's rows belonged to the other screen.
            if (selection.active) {
                selection.clear()
                view?.onSelectionChanged()
            }
        }
        val back = topRow < 0
        if (back != scrolledBack) scrolledBack = back
        val selected = selection.active
        if (selected != hasSelection) hasSelection = selected
    }

    private fun cancelHoldTimeout() {
        holdTimeout?.let { mainHandler.removeCallbacks(it) }
        holdTimeout = null
    }

    private fun newEmulator(g: TerminalGrid): TerminalEmulator =
        TerminalEmulator(output, g.cols, g.rows, scrollbackRows, client).apply {
            // The view drives blinking (and hides the renderer's cursor while unfocused).
            setCursorBlinkingEnabled(true)
            setCursorBlinkState(true)
        }

    private fun isMainThread(): Boolean = Looper.myLooper() == Looper.getMainLooper()

    private fun checkMainThread() {
        check(isMainThread()) { "TerminalState must be used on the main thread" }
    }

    /** Receives what the emulator produces while parsing output. */
    private inner class Output : TerminalOutput() {
        override fun write(data: ByteArray, offset: Int, count: Int) {
            if (suppressReplies || count <= 0) return
            onInput?.invoke(data.copyOfRange(offset, offset + count))
        }

        override fun titleChanged(oldTitle: String?, newTitle: String?) {
            title = newTitle
            onTitle?.invoke(newTitle)
        }

        override fun onCopyTextToClipboard(text: String?) {
            if (replaying || text == null) return
            val handler = onClipboardCopy
            if (handler != null) handler(text) else view?.copyToClipboard(text)
        }

        override fun onPasteTextFromClipboard() {}

        override fun onBell() {
            if (replaying) return
            val now = SystemClock.uptimeMillis()
            if (now - lastBellAt < BELL_INTERVAL_MS) return
            lastBellAt = now
            val handler = onBell
            if (handler != null) handler() else view?.defaultBell()
        }

        override fun onColorsChanged() {
            view?.invalidate()
        }
    }

    /** Termux's session callbacks we have no session for; its logging is silenced. */
    private inner class QuietClient : TerminalSessionClient {
        override fun onTextChanged(changedSession: TerminalSession?) {}

        override fun onTitleChanged(changedSession: TerminalSession?) {}

        override fun onSessionFinished(finishedSession: TerminalSession?) {}

        override fun onCopyTextToClipboard(session: TerminalSession?, text: String?) {}

        override fun onPasteTextFromClipboard(session: TerminalSession?) {}

        override fun onBell(session: TerminalSession?) {}

        override fun onColorsChanged(session: TerminalSession?) {}

        override fun onTerminalCursorStateChange(state: Boolean) {
            view?.invalidate()
        }

        override fun getTerminalCursorStyle(): Int? = null

        override fun logError(tag: String?, message: String?) {}

        override fun logWarn(tag: String?, message: String?) {}

        override fun logInfo(tag: String?, message: String?) {}

        override fun logDebug(tag: String?, message: String?) {}

        override fun logVerbose(tag: String?, message: String?) {}

        override fun logStackTraceWithMessage(tag: String?, message: String?, e: Exception?) {}

        override fun logStackTrace(tag: String?, e: Exception?) {}
    }

    companion object {
        const val DEFAULT_SCROLLBACK_ROWS: Int = 3000

        /** How long Local waits for the daemon's `size` frame before playing a replay anyway (iOS). */
        const val DEFAULT_HOLD_MILLIS: Long = 1500

        internal const val MAX_PENDING_BYTES = 2 * 1024 * 1024
        internal const val MIN_GRID = 2
        internal const val MAX_GRID = 1000
        private const val BELL_INTERVAL_MS = 250L
        private val FALLBACK_GRID = TerminalGrid(80, 24)

        private fun initialGrid(mode: TerminalGridMode): TerminalGrid =
            if (mode is TerminalGridMode.Fixed) mode.grid else FALLBACK_GRID

        /** Termux can't lay out fewer than 2×2; the server caps PTYs at 1000×1000. */
        private fun sanitize(mode: TerminalGridMode): TerminalGridMode =
            when (mode) {
                TerminalGridMode.Fit -> mode
                is TerminalGridMode.Fixed ->
                    TerminalGridMode.Fixed(mode.cols.coerceIn(MIN_GRID, MAX_GRID), mode.rows.coerceIn(MIN_GRID, MAX_GRID))
            }
    }
}
