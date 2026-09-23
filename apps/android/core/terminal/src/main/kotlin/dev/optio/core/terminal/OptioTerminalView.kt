package dev.optio.core.terminal

import android.annotation.SuppressLint
import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.res.Configuration
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Rect
import android.graphics.RectF
import android.graphics.Typeface
import android.os.Build
import android.os.SystemClock
import android.text.InputType
import android.util.AttributeSet
import android.view.ActionMode
import android.view.GestureDetector
import android.view.HapticFeedbackConstants
import android.view.InputDevice
import android.view.KeyEvent
import android.view.Menu
import android.view.MenuItem
import android.view.MotionEvent
import android.view.View
import android.view.accessibility.AccessibilityNodeInfo
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.OverScroller
import android.window.OnBackInvokedCallback
import android.window.OnBackInvokedDispatcher
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle
import com.termux.terminal.WcWidth
import kotlin.math.abs
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The terminal on screen. Renders a [TerminalState]'s Termux emulator with Termux's
 * `TerminalRenderer` inside this View (Termux's own `TerminalView` needs a `TerminalSession`, which
 * forks a local process), and turns touch, hardware keys and the soft keyboard into bytes for
 * [TerminalState.onInput]. Compose screens use [TerminalSurface].
 *
 * - **Grid.** [TerminalGridMode.Fit]: cols × rows from the view size at [fontSizeDp].
 *   [TerminalGridMode.Fixed]: exactly the given grid, the font scaled so it fits (and panned when it
 *   is clamped at the minimum size). The PTY is never resized from here; the state reports.
 * - **Scrolling follows what the program wants** (see [TerminalDragAction]): wheel reports while it
 *   tracks the mouse, arrow keys on an alternate screen without mouse tracking, otherwise the
 *   scrollback, with fling. New output follows the bottom unless the user scrolled up.
 * - **Taps** focus the terminal and raise the keyboard (never mouse clicks); **long-press** selects a
 *   word, drag to extend, handles to adjust, then Copy / Select all / Paste.
 * - **Focus is the claim signal** for Local, so the view never takes focus on its own in touch mode;
 *   only a tap, [TerminalState.focus], or keyboard navigation gives it focus.
 */
class OptioTerminalView
@JvmOverloads
constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
) : View(context, attrs, defStyleAttr) {
    /** The terminal shown. A state shows in one view at a time; attaching it here detaches it elsewhere. */
    var state: TerminalState? = null
        set(value) {
            if (field === value) return
            val old = field
            field = value
            old?.detachView(this)
            value?.attachView(this)
            onStateReplaced()
        }

    /** Dark or light palette ([TerminalTheme]); re-themes a live terminal in place. */
    var dark: Boolean = isNightMode(context)
        set(value) {
            if (field == value) return
            field = value
            state?.applyTheme(value)
            invalidate()
        }

    /** How the soft keyboard talks to the terminal. */
    var inputMode: TerminalInputMode = TerminalInputMode.Text
        set(value) {
            if (field == value) return
            field = value
            inputMethodManager()?.restartInput(this)
        }

    /** The font size the grid is ours at (Fit mode), in dp. iOS: 12 pt. */
    var fontSizeDp: Float = TerminalSizing.BASE_FONT_DP.toFloat()
        set(value) {
            require(value > 0f) { "fontSizeDp must be positive" }
            if (field == value) return
            field = value
            relayout()
        }

    /** The terminal font; defaults to the bundled JetBrains Mono ([TerminalFonts]). */
    var typeface: Typeface = TerminalFonts.typeface(context)
        set(value) {
            if (field === value) return
            field = value
            metricsCache.clear()
            relayout()
        }

    /**
     * On an alternate screen without mouse tracking (`less`, `man`), a vertical drag sends arrow
     * keys, one per row (xterm's "alternate scroll"). Off: the drag does nothing there.
     */
    var arrowKeysScrollAltScreen: Boolean = true

    private val density = resources.displayMetrics.density
    private val metricsCache = CellMetricsCache()
    private var baseMetrics: CellMetrics? = null

    internal var drawMetrics: CellMetrics? = null
        private set
    internal var panX = 0f
        private set
    internal var panY = 0f
        private set
    internal var maxPanX = 0f
        private set
    internal var maxPanY = 0f
        private set

    private var composing = ""
    private var inputConnection: TerminalInputConnection? = null
    private var focusAllowed = false

    private val overlayPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val composingPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val scratchRect = RectF()

    private var cursorBlinkOn = true
    private val blinkTick =
        object : Runnable {
            override fun run() {
                cursorBlinkOn = !cursorBlinkOn
                invalidate()
                postDelayed(this, CURSOR_BLINK_MS)
            }
        }

    private var syncFallbackPosted = false
    private val syncFallback =
        Runnable {
            syncFallbackPosted = false
            invalidate()
        }

    private var indicatorsShownAt = Long.MIN_VALUE / 2

    // Gestures
    private val gestureDetector = GestureDetector(context, Gestures())
    private val scrollbackScroller = OverScroller(context)
    private val panScroller = OverScroller(context)
    private val rowAccumulator = RowAccumulator()
    private var dragAxis = AXIS_NONE
    private var wheelFling: WheelFling? = null
    private var wheelFlingX = 0f
    private var wheelFlingY = 0f
    private val wheelFlingTick =
        object : Runnable {
            override fun run() = stepWheelFling()
        }

    // Selection
    private var selectingDrag = false
    private var anchorRow = 0
    private var anchorStart = 0
    private var anchorEnd = 0
    private var handleDrag = HANDLE_NONE
    private var actionMode: ActionMode? = null
    private var backCallback: Any? = null

    init {
        isFocusable = true
        isFocusableInTouchMode = true
        isHapticFeedbackEnabled = true
        defaultFocusHighlightEnabled = false
        importantForAutofill = IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    }

    // region Layout

    /** Sets the padding around the grid (px); relayouts only when it changes. */
    fun setTerminalPadding(left: Int, top: Int, right: Int, bottom: Int) {
        if (left == paddingLeft && top == paddingTop && right == paddingRight && bottom == paddingBottom) return
        setPadding(left, top, right, bottom)
        relayout()
    }

    override fun onSizeChanged(w: Int, h: Int, oldw: Int, oldh: Int) {
        super.onSizeChanged(w, h, oldw, oldh)
        relayout()
    }

    private fun contentWidth(): Int = width - paddingLeft - paddingRight

    private fun contentHeight(): Int = height - paddingTop - paddingBottom

    private fun baseTextPx(): Int = max(1, (fontSizeDp * density).roundToInt())

    private fun cellAt(px: Int): TerminalLayout.Cell {
        val m = metricsCache.get(px, typeface)
        return TerminalLayout.Cell(m.cellWidth, m.lineHeight)
    }

    /** Measures the natural grid, tells the state (which may resize the emulator), then lays the grid out. */
    private fun relayout() {
        val st = state ?: return
        val w = contentWidth()
        val h = contentHeight()
        if (w <= 0 || h <= 0) return
        val base = metricsCache.get(baseTextPx(), typeface)
        baseMetrics = base
        st.onViewLaidOut(TerminalLayout.naturalGrid(w.toFloat(), h.toFloat(), TerminalLayout.Cell(base.cellWidth, base.lineHeight)))
        layoutGrid()
    }

    /** Picks the drawing font for the grid mode, and the pan range when the grid overflows. */
    private fun layoutGrid() {
        val st = state ?: return
        val base = baseMetrics ?: return
        val w = contentWidth().toFloat()
        val h = contentHeight().toFloat()
        if (w <= 0f || h <= 0f) return
        val metrics =
            when (val mode = st.gridMode) {
                TerminalGridMode.Fit -> base
                is TerminalGridMode.Fixed -> {
                    val minPx = max(1, (TerminalSizing.MIN_PASSIVE_FONT_DP * density).roundToInt())
                    val maxPx = max(minPx, (TerminalSizing.MAX_PASSIVE_FONT_DP * density).roundToInt())
                    val px = TerminalLayout.fixedTextSize(mode.cols, mode.rows, w, h, base.textSize, minPx, maxPx, ::cellAt)
                    metricsCache.get(px, typeface)
                }
            }
        drawMetrics = metrics
        val wasPannable = maxPanX > 0f || maxPanY > 0f
        maxPanX = max(0f, st.grid.cols * metrics.cellWidth - w)
        maxPanY = max(0f, (st.grid.rows * metrics.lineHeight).toFloat() - h)
        panX = panX.coerceIn(0f, maxPanX)
        panY = panY.coerceIn(0f, maxPanY)
        if (!wasPannable && (maxPanX > 0f || maxPanY > 0f)) flashIndicators()
        invalidate()
    }

    // endregion

    // region State callbacks

    private fun onStateReplaced() {
        finishSelectionUi()
        stopFlings()
        setComposing("")
        val st = state
        if (st != null) {
            st.applyTheme(dark)
            st.isFocused = isFocused
            if (st.takeFocusRequest() && isAttachedToWindow) post { requestTerminalFocus(showKeyboard = true) }
        }
        relayout()
        invalidate()
    }

    internal fun onScreenUpdated(synchronized: Boolean) {
        if (synchronized) {
            // Mid-redraw (`?2026`): hold the frame until the program ends it, or a short timeout.
            if (!syncFallbackPosted) {
                syncFallbackPosted = true
                postDelayed(syncFallback, SYNC_OUTPUT_TIMEOUT_MS)
            }
        } else {
            if (syncFallbackPosted) {
                removeCallbacks(syncFallback)
                syncFallbackPosted = false
            }
            invalidate()
        }
    }

    internal fun onEmulatorReplaced() {
        finishSelectionUi()
        stopFlings()
        relayout()
        invalidate()
    }

    internal fun onGridModeChanged() = layoutGrid()

    internal fun onSelectionChanged() {
        invalidate()
        if (state?.selection?.active == true) {
            registerBackCallback()
            actionMode?.invalidateContentRect()
        } else {
            actionMode?.finish()
            actionMode = null
            unregisterBackCallback()
        }
    }

    internal fun onUserInput() = restartBlink()

    internal fun copyToClipboard(text: String) {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        clipboard.setPrimaryClip(ClipData.newPlainText("Terminal", text))
    }

    internal fun defaultBell() {
        performHapticFeedback(if (Build.VERSION.SDK_INT >= 30) HapticFeedbackConstants.REJECT else HapticFeedbackConstants.LONG_PRESS)
    }

    // endregion

    // region Drawing

    override fun onDraw(canvas: Canvas) {
        val st = state
        val metrics = drawMetrics
        val emulator = st?.emulator
        val palette = emulator?.mColors?.mCurrentColors
        canvas.drawColor(palette?.get(TextStyle.COLOR_INDEX_BACKGROUND) ?: TerminalTheme.backgroundArgb(dark))
        if (st == null || metrics == null || emulator == null || palette == null) return

        val originX = paddingLeft - panX
        val originY = paddingTop - panY
        val focused = isFocused && hasWindowFocus()
        // The renderer draws a solid cursor while we're focused and the blink is "on"; unfocused it
        // is an outline (below), and the IME's composing text takes its place while composing.
        emulator.setCursorBlinkState(focused && cursorBlinkOn && composing.isEmpty())

        canvas.save()
        canvas.translate(originX, originY - metrics.topOffset)
        metrics.renderer.render(emulator, canvas, st.topRow, -1, -1, -1, -1)
        canvas.restore()

        val cursorScreenRow = emulator.cursorRow - st.topRow
        val cursorOnScreen = emulator.isCursorEnabled && cursorScreenRow in 0 until emulator.mRows
        canvas.save()
        canvas.translate(originX, originY)
        if (st.selection.active) drawSelection(canvas, st, emulator, metrics)
        if (composing.isNotEmpty() && cursorScreenRow in 0 until emulator.mRows) {
            drawComposing(canvas, emulator, metrics, palette, cursorScreenRow)
        } else if (!focused && cursorOnScreen) {
            drawOutlineCursor(canvas, emulator, metrics, palette, cursorScreenRow)
        }
        canvas.restore()
        drawIndicators(canvas, st, emulator, metrics, palette)
    }

    private fun drawSelection(canvas: Canvas, st: TerminalState, emulator: TerminalEmulator, m: CellMetrics) {
        val sel = st.selection
        overlayPaint.style = Paint.Style.FILL
        overlayPaint.color = TerminalTheme.selectionArgb(dark)
        val first = max(sel.startRow, st.topRow)
        val last = min(sel.endRow, st.topRow + emulator.mRows - 1)
        for (row in first..last) {
            val c1 = if (row == sel.startRow) sel.startCol else 0
            val c2 = if (row == sel.endRow) sel.endCol else emulator.mColumns - 1
            val y = ((row - st.topRow) * m.lineHeight).toFloat()
            canvas.drawRect(c1 * m.cellWidth, y, (c2 + 1) * m.cellWidth, y + m.lineHeight, overlayPaint)
        }
        if (selectingDrag) return
        overlayPaint.color = TerminalTheme.ACCENT_ARGB
        val r = HANDLE_RADIUS_DP * density
        for (start in booleanArrayOf(true, false)) {
            val (x, y) = handleAnchor(start, st, m)
            if (y < -r || y > height + r) continue
            canvas.drawRect(x - density, y - m.lineHeight, x + density, y, overlayPaint)
            canvas.drawCircle(x, y + r, r, overlayPaint)
        }
    }

    private fun drawOutlineCursor(canvas: Canvas, e: TerminalEmulator, m: CellMetrics, palette: IntArray, row: Int) {
        val stroke = max(1f, density)
        overlayPaint.style = Paint.Style.STROKE
        overlayPaint.strokeWidth = stroke
        overlayPaint.color = palette[TextStyle.COLOR_INDEX_CURSOR]
        val x = e.cursorCol * m.cellWidth
        val y = (row * m.lineHeight).toFloat()
        canvas.drawRect(x + stroke / 2, y + stroke / 2, x + m.cellWidth - stroke / 2, y + m.lineHeight - stroke / 2, overlayPaint)
        overlayPaint.style = Paint.Style.FILL
    }

    private fun drawComposing(canvas: Canvas, e: TerminalEmulator, m: CellMetrics, palette: IntArray, row: Int) {
        var cells = 0
        var i = 0
        while (i < composing.length) {
            val cp = composing.codePointAt(i)
            cells += max(0, WcWidth.width(cp))
            i += Character.charCount(cp)
        }
        val x = e.cursorCol * m.cellWidth
        val y = (row * m.lineHeight).toFloat()
        val right = x + max(1, cells) * m.cellWidth
        overlayPaint.style = Paint.Style.FILL
        overlayPaint.color = palette[TextStyle.COLOR_INDEX_BACKGROUND]
        canvas.drawRect(x, y, right, y + m.lineHeight, overlayPaint)
        composingPaint.typeface = typeface
        composingPaint.textSize = m.textSize.toFloat()
        composingPaint.color = palette[TextStyle.COLOR_INDEX_FOREGROUND]
        canvas.drawText(composing, x, y + m.baseline, composingPaint)
        overlayPaint.color = TerminalTheme.ACCENT_ARGB
        canvas.drawRect(x, y + m.lineHeight - 2 * density, right, y + m.lineHeight - 0.5f * density, overlayPaint)
    }

    /** Thin scroll/pan indicators that show while scrolling or panning, then fade. */
    private fun drawIndicators(canvas: Canvas, st: TerminalState, e: TerminalEmulator, m: CellMetrics, palette: IntArray) {
        val age = SystemClock.uptimeMillis() - indicatorsShownAt
        val alpha =
            when {
                age < INDICATOR_HOLD_MS -> 1f
                age < INDICATOR_HOLD_MS + INDICATOR_FADE_MS -> 1f - (age - INDICATOR_HOLD_MS).toFloat() / INDICATOR_FADE_MS
                else -> return
            }
        postInvalidateOnAnimation()
        val fg = palette[TextStyle.COLOR_INDEX_FOREGROUND]
        overlayPaint.style = Paint.Style.FILL
        overlayPaint.color = (fg and 0x00FFFFFF) or ((0x60 * alpha).roundToInt() shl 24)
        val thickness = 3 * density
        val inset = 2 * density
        val w = contentWidth().toFloat()
        val h = contentHeight().toFloat()
        // Vertical: pan position, or where the screen sits in the scrollback.
        val transcript = e.screen.activeTranscriptRows
        val (vFraction, vOffset) =
            when {
                maxPanY > 0f -> h / (h + maxPanY) to panY / maxPanY
                !e.isAlternateBufferActive && transcript > 0 -> {
                    val total = transcript + e.mRows
                    e.mRows.toFloat() / total to (transcript + st.topRow).toFloat() / transcript
                }
                else -> 0f to 0f
            }
        if (vFraction > 0f && vFraction < 1f) {
            val track = h - 2 * inset
            val thumb = max(24 * density, track * vFraction)
            val top = paddingTop + inset + (track - thumb) * vOffset
            scratchRect.set(width - inset - thickness, top, width - inset, top + thumb)
            canvas.drawRoundRect(scratchRect, thickness, thickness, overlayPaint)
        }
        if (maxPanX > 0f) {
            val track = w - 2 * inset
            val thumb = max(24 * density, track * (w / (w + maxPanX)))
            val left = paddingLeft + inset + (track - thumb) * (panX / maxPanX)
            scratchRect.set(left, height - inset - thickness, left + thumb, height - inset)
            canvas.drawRoundRect(scratchRect, thickness, thickness, overlayPaint)
        }
    }

    private fun flashIndicators() {
        indicatorsShownAt = SystemClock.uptimeMillis()
        postInvalidateOnAnimation()
    }

    // endregion

    // region Touch

    /** Column under view x (unclamped). */
    private fun colAt(x: Float): Int {
        val m = drawMetrics ?: return 0
        return kotlin.math.floor((x - paddingLeft + panX) / m.cellWidth).toInt()
    }

    /** Screen row (0 = top of the visible grid) under view y (unclamped). */
    private fun screenRowAt(y: Float): Int {
        val m = drawMetrics ?: return 0
        return kotlin.math.floor((y - paddingTop + panY) / m.lineHeight).toInt()
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onTouchEvent(event: MotionEvent): Boolean {
        val st = state ?: return super.onTouchEvent(event)
        if (drawMetrics == null) return true
        if (event.actionMasked == MotionEvent.ACTION_DOWN) {
            stopFlings()
            dragAxis = AXIS_NONE
            rowAccumulator.reset()
            handleDrag = if (st.selection.active) hitHandle(event.x, event.y) else HANDLE_NONE
            if (handleDrag != HANDLE_NONE) {
                parent?.requestDisallowInterceptTouchEvent(true)
                actionMode?.hide(ActionMode.DEFAULT_HIDE_DURATION.toLong())
                return true
            }
        }
        if (handleDrag != HANDLE_NONE) {
            dragHandle(event)
            return true
        }
        if (selectingDrag) {
            extendSelection(event)
            return true
        }
        gestureDetector.onTouchEvent(event)
        if (event.actionMasked == MotionEvent.ACTION_UP || event.actionMasked == MotionEvent.ACTION_CANCEL) {
            parent?.requestDisallowInterceptTouchEvent(false)
        }
        return true
    }

    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        val st = state
        if (st != null && event.isFromSource(InputDevice.SOURCE_CLASS_POINTER) && event.actionMasked == MotionEvent.ACTION_SCROLL) {
            val v = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
            if (v == 0f) return false
            val up = v > 0f
            when (TerminalScrollPolicy.dragAction(st.mouseTracking, st.altScreen, arrowKeysScrollAltScreen)) {
                TerminalDragAction.WheelReports -> sendWheel(if (up) 1 else -1, event.x, event.y)
                TerminalDragAction.ArrowKeys -> sendScrollArrows(if (up) TerminalScrollPolicy.MOUSE_WHEEL_ROWS else -TerminalScrollPolicy.MOUSE_WHEEL_ROWS)
                TerminalDragAction.Scrollback -> {
                    st.scrollBy(if (up) -TerminalScrollPolicy.MOUSE_WHEEL_ROWS else TerminalScrollPolicy.MOUSE_WHEEL_ROWS)
                    flashIndicators()
                }
                TerminalDragAction.None -> {}
            }
            return true
        }
        return super.onGenericMotionEvent(event)
    }

    private inner class Gestures : GestureDetector.SimpleOnGestureListener() {
        override fun onDown(e: MotionEvent): Boolean = true

        override fun onSingleTapUp(e: MotionEvent): Boolean {
            onTap()
            return true
        }

        override fun onLongPress(e: MotionEvent) {
            if (dragAxis == AXIS_NONE) beginSelection(e)
        }

        override fun onScroll(e1: MotionEvent?, e2: MotionEvent, distanceX: Float, distanceY: Float): Boolean {
            onDrag(e2, distanceX, distanceY)
            return true
        }

        override fun onFling(e1: MotionEvent?, e2: MotionEvent, velocityX: Float, velocityY: Float): Boolean {
            onFlingGesture(e2, velocityX, velocityY)
            return true
        }
    }

    private fun onTap() {
        val st = state ?: return
        if (st.selection.active) {
            st.clearSelection()
            return
        }
        if (isFocused) {
            showSoftKeyboard()
            st.notifyInteraction()
        } else {
            // Taking focus fires the interaction (onFocusChanged).
            requestTerminalFocus(showKeyboard = true)
        }
    }

    private fun onDrag(e: MotionEvent, dx: Float, dy: Float) {
        val m = drawMetrics ?: return
        parent?.requestDisallowInterceptTouchEvent(true)
        if (dragAxis == AXIS_NONE) dragAxis = if (abs(dx) > abs(dy) && maxPanX > 0f) AXIS_X else AXIS_Y
        if (dragAxis == AXIS_X) {
            panTo(panX + dx, panY)
            return
        }
        val travel = -dy // finger moving down is positive: older content
        if (maxPanY > 0f) {
            val next = (panY - travel).coerceIn(0f, maxPanY)
            if (next != panY) {
                panTo(panX, next)
                return
            }
        }
        val rows = rowAccumulator.add(travel, m.lineHeight.toFloat())
        if (rows != 0) scrollRows(rows, e.x, e.y)
    }

    /** [rows] > 0: older content (wheel up, scroll back, arrow up). */
    private fun scrollRows(rows: Int, x: Float, y: Float) {
        val st = state ?: return
        when (TerminalScrollPolicy.dragAction(st.mouseTracking, st.altScreen, arrowKeysScrollAltScreen)) {
            TerminalDragAction.WheelReports -> sendWheel(rows, x, y)
            TerminalDragAction.ArrowKeys -> sendScrollArrows(rows)
            TerminalDragAction.Scrollback -> {
                st.scrollBy(-rows)
                flashIndicators()
            }
            TerminalDragAction.None -> {}
        }
    }

    /** Wheel reports in the program's encoding (SGR or X10), at the cell under ([x], [y]). */
    internal fun sendWheel(notches: Int, x: Float, y: Float) {
        val st = state ?: return
        val e = st.emulator
        val col = (colAt(x) + 1).coerceIn(1, e.mColumns)
        val row = (screenRowAt(y) + 1).coerceIn(1, e.mRows)
        val button = if (notches > 0) TerminalEmulator.MOUSE_WHEELUP_BUTTON else TerminalEmulator.MOUSE_WHEELDOWN_BUTTON
        repeat(abs(notches)) { e.sendMouseEvent(button, col, row, true) }
    }

    private fun sendScrollArrows(rows: Int) {
        val st = state ?: return
        val key = TerminalKey.Special(if (rows > 0) KeyEvent.KEYCODE_DPAD_UP else KeyEvent.KEYCODE_DPAD_DOWN)
        val bytes = TerminalKeys.encode(key, applicationCursor = st.emulator.isCursorKeysApplicationMode)
        repeat(abs(rows)) { st.programInput(bytes) }
    }

    private fun panTo(x: Float, y: Float) {
        val nx = x.coerceIn(0f, maxPanX)
        val ny = y.coerceIn(0f, maxPanY)
        if (nx == panX && ny == panY) return
        panX = nx
        panY = ny
        flashIndicators()
        invalidate()
    }

    private fun onFlingGesture(e: MotionEvent, vx: Float, vy: Float) {
        val st = state ?: return
        val m = drawMetrics ?: return
        when (dragAxis) {
            AXIS_X -> {
                panScroller.fling(panX.roundToInt(), panY.roundToInt(), -vx.roundToInt(), 0, 0, maxPanX.roundToInt(), panY.roundToInt(), panY.roundToInt())
                postInvalidateOnAnimation()
            }
            AXIS_Y -> {
                if (maxPanY > 0f) {
                    panScroller.fling(panX.roundToInt(), panY.roundToInt(), 0, -vy.roundToInt(), panX.roundToInt(), panX.roundToInt(), 0, maxPanY.roundToInt())
                    postInvalidateOnAnimation()
                    return
                }
                when (TerminalScrollPolicy.dragAction(st.mouseTracking, st.altScreen, arrowKeysScrollAltScreen)) {
                    TerminalDragAction.WheelReports -> startWheelFling(vy, e.x, e.y)
                    TerminalDragAction.Scrollback -> {
                        val lh = m.lineHeight
                        val maxBack = st.emulator.screen.activeTranscriptRows * lh
                        scrollbackScroller.fling(0, -st.topRow * lh, 0, vy.roundToInt(), 0, 0, 0, maxBack)
                        postInvalidateOnAnimation()
                    }
                    else -> {}
                }
            }
        }
    }

    override fun computeScroll() {
        val st = state ?: return
        val m = drawMetrics ?: return
        if (scrollbackScroller.computeScrollOffset()) {
            val target = -(scrollbackScroller.currY / m.lineHeight)
            st.scrollBy(target - st.topRow)
            flashIndicators()
            postInvalidateOnAnimation()
        }
        if (panScroller.computeScrollOffset()) {
            panTo(panScroller.currX.toFloat(), panScroller.currY.toFloat())
            postInvalidateOnAnimation()
        }
    }

    private fun startWheelFling(velocityY: Float, x: Float, y: Float) {
        val fling = WheelFling(velocityY, density)
        if (!fling.started) return
        wheelFling = fling
        wheelFlingX = x
        wheelFlingY = y
        removeCallbacks(wheelFlingTick)
        postDelayed(wheelFlingTick, WHEEL_TICK_MS)
    }

    private fun stepWheelFling() {
        val fling = wheelFling ?: return
        val st = state
        val m = drawMetrics
        val travel = fling.step()
        // The program stopped tracking the mouse mid-fling: stop rather than scroll something else.
        if (travel == null || st == null || m == null || !st.mouseTracking) {
            wheelFling = null
            return
        }
        val rows = rowAccumulator.add(travel, m.lineHeight.toFloat())
        if (rows != 0) sendWheel(rows, wheelFlingX, wheelFlingY)
        if (fling.finished) wheelFling = null else postDelayed(wheelFlingTick, WHEEL_TICK_MS)
    }

    private fun stopFlings() {
        scrollbackScroller.forceFinished(true)
        panScroller.forceFinished(true)
        wheelFling = null
        removeCallbacks(wheelFlingTick)
    }

    // endregion

    // region Selection

    private fun bufferCell(x: Float, y: Float, xBias: Float = 0f): Pair<Int, Int> {
        val st = state ?: return 0 to 0
        val e = st.emulator
        val col = colAt(x + xBias).coerceIn(0, e.mColumns - 1)
        val row = screenRowAt(y).coerceIn(0, e.mRows - 1) + st.topRow
        return col to row
    }

    private fun beginSelection(e: MotionEvent) {
        val st = state ?: return
        val em = st.emulator
        val (col, row) = bufferCell(e.x, e.y)
        val word = TerminalSelection.wordAt(em.screen, col, row, em.mColumns)
        anchorRow = row
        anchorStart = word.first
        anchorEnd = word.last
        selectingDrag = true
        st.select(word.first, row, word.last, row)
        parent?.requestDisallowInterceptTouchEvent(true)
        performHapticFeedback(HapticFeedbackConstants.LONG_PRESS)
    }

    private fun extendSelection(e: MotionEvent) {
        val st = state ?: return
        when (e.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val (col, row) = bufferCell(e.x, e.y)
                if (row < anchorRow || (row == anchorRow && col < anchorStart)) {
                    st.select(col, row, anchorEnd, anchorRow)
                } else {
                    st.select(anchorStart, anchorRow, col, row)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                selectingDrag = false
                parent?.requestDisallowInterceptTouchEvent(false)
                invalidate()
                showSelectionToolbar()
            }
        }
    }

    /** Where a handle hangs from, in view coordinates: the bottom-left of the first cell / bottom-right of the last. */
    private fun handleAnchor(start: Boolean, st: TerminalState, m: CellMetrics): Pair<Float, Float> {
        val sel = st.selection
        val originX = paddingLeft - panX
        val originY = paddingTop - panY
        return if (start) {
            originX + sel.startCol * m.cellWidth to originY + (sel.startRow - st.topRow + 1) * m.lineHeight
        } else {
            originX + (sel.endCol + 1) * m.cellWidth to originY + (sel.endRow - st.topRow + 1) * m.lineHeight
        }
    }

    private fun hitHandle(x: Float, y: Float): Int {
        val st = state ?: return HANDLE_NONE
        val m = drawMetrics ?: return HANDLE_NONE
        val r = HANDLE_RADIUS_DP * density
        val slop = HANDLE_TOUCH_DP * density
        for ((handle, start) in listOf(HANDLE_END to false, HANDLE_START to true)) {
            val (hx, hy) = handleAnchor(start, st, m)
            if (hypot(x - hx, y - (hy + r)) <= slop) return handle
        }
        return HANDLE_NONE
    }

    private fun dragHandle(e: MotionEvent) {
        val st = state ?: return
        val m = drawMetrics ?: return
        when (e.actionMasked) {
            MotionEvent.ACTION_MOVE -> {
                val sel = st.selection
                // The finger holds the handle below the line; aim at the row above it.
                val y = e.y - HANDLE_RADIUS_DP * density - m.lineHeight / 2f
                if (handleDrag == HANDLE_START) {
                    val (col, row) = bufferCell(e.x, y, m.cellWidth / 2f)
                    st.select(col, row, sel.endCol, sel.endRow)
                } else {
                    val (col, row) = bufferCell(e.x, y, -m.cellWidth / 2f)
                    st.select(sel.startCol, sel.startRow, col, row)
                }
            }
            MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                handleDrag = HANDLE_NONE
                parent?.requestDisallowInterceptTouchEvent(false)
                showSelectionToolbar()
            }
        }
    }

    private fun showSelectionToolbar() {
        if (state?.selection?.active != true) return
        val mode = actionMode
        if (mode != null) {
            mode.invalidateContentRect()
            mode.hide(0)
            return
        }
        actionMode = startActionMode(SelectionActions(), ActionMode.TYPE_FLOATING)
    }

    private fun finishSelectionUi() {
        selectingDrag = false
        handleDrag = HANDLE_NONE
        actionMode?.finish()
        actionMode = null
        unregisterBackCallback()
    }

    private inner class SelectionActions : ActionMode.Callback2() {
        override fun onCreateActionMode(mode: ActionMode, menu: Menu): Boolean {
            val show = MenuItem.SHOW_AS_ACTION_IF_ROOM or MenuItem.SHOW_AS_ACTION_WITH_TEXT
            menu.add(Menu.NONE, MENU_COPY, 0, android.R.string.copy).setShowAsAction(show)
            menu.add(Menu.NONE, MENU_SELECT_ALL, 1, android.R.string.selectAll).setShowAsAction(show)
            menu.add(Menu.NONE, MENU_PASTE, 2, android.R.string.paste).apply {
                setShowAsAction(show)
                isEnabled = clipboardHasText()
            }
            return true
        }

        override fun onPrepareActionMode(mode: ActionMode, menu: Menu): Boolean = false

        override fun onActionItemClicked(mode: ActionMode, item: MenuItem): Boolean {
            val st = state ?: return true
            when (item.itemId) {
                MENU_COPY -> {
                    copySelection()
                    st.clearSelection()
                }
                MENU_SELECT_ALL -> {
                    st.selectAll()
                    return true
                }
                MENU_PASTE -> {
                    st.clearSelection()
                    pasteFromClipboard()
                }
            }
            mode.finish()
            return true
        }

        override fun onDestroyActionMode(mode: ActionMode) {
            if (actionMode === mode) actionMode = null
        }

        override fun onGetContentRect(mode: ActionMode, view: View, outRect: Rect) {
            val st = state
            val m = drawMetrics
            if (st == null || m == null || !st.selection.active) {
                outRect.set(0, 0, width, height)
                return
            }
            val sel = st.selection
            val originX = paddingLeft - panX
            val originY = paddingTop - panY
            val top = originY + (sel.startRow - st.topRow) * m.lineHeight
            val bottom = originY + (sel.endRow - st.topRow + 1) * m.lineHeight
            val left = if (sel.startRow == sel.endRow) originX + sel.startCol * m.cellWidth else 0f
            val right = if (sel.startRow == sel.endRow) originX + (sel.endCol + 1) * m.cellWidth else width.toFloat()
            outRect.set(
                left.roundToInt().coerceIn(0, width),
                top.roundToInt().coerceIn(0, height),
                right.roundToInt().coerceIn(0, width),
                bottom.roundToInt().coerceIn(0, height),
            )
        }
    }

    private fun registerBackCallback() {
        if (Build.VERSION.SDK_INT < 33 || backCallback != null) return
        val dispatcher = findOnBackInvokedDispatcher() ?: return
        val callback = OnBackInvokedCallback { state?.clearSelection() }
        dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_OVERLAY, callback)
        backCallback = callback
    }

    private fun unregisterBackCallback() {
        if (Build.VERSION.SDK_INT < 33) return
        val callback = backCallback as? OnBackInvokedCallback ?: return
        findOnBackInvokedDispatcher()?.unregisterOnBackInvokedCallback(callback)
        backCallback = null
    }

    /** Copies the selection to the clipboard; false when nothing is selected. */
    fun copySelection(): Boolean {
        val text = state?.selectedText()
        if (text.isNullOrEmpty()) return false
        copyToClipboard(text)
        return true
    }

    /** Pastes the clipboard's text into the terminal (bracketed when the program asked for it). */
    fun pasteFromClipboard() {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return
        val clip = clipboard.primaryClip ?: return
        if (clip.itemCount == 0) return
        val text = clip.getItemAt(0).coerceToText(context)?.toString()
        if (!text.isNullOrEmpty()) state?.paste(text)
    }

    private fun clipboardHasText(): Boolean {
        val clipboard = context.getSystemService(ClipboardManager::class.java) ?: return false
        return clipboard.hasPrimaryClip()
    }

    // endregion

    // region Focus, keyboard and IME

    /**
     * Never takes focus on its own in touch mode (the window's initial focus pass, focus moving on
     * after another view clears it): focus is the claim signal for Local, so it must come from the
     * user (a tap, keyboard navigation) or from [TerminalState.focus].
     */
    override fun requestFocus(direction: Int, previouslyFocusedRect: Rect?): Boolean {
        if (isInTouchMode && !focusAllowed && !isFocused) return false
        return super.requestFocus(direction, previouslyFocusedRect)
    }

    /** Takes input focus (and shows the soft keyboard). */
    fun requestTerminalFocus(showKeyboard: Boolean) {
        focusAllowed = true
        try {
            if (!isFocused) requestFocus()
        } finally {
            focusAllowed = false
        }
        if (showKeyboard && isFocused) showSoftKeyboard()
    }

    /** Hides the soft keyboard and gives up focus. */
    fun releaseTerminalFocus() {
        inputMethodManager()?.hideSoftInputFromWindow(windowToken, 0)
        clearFocus()
    }

    private fun showSoftKeyboard() {
        val imm = inputMethodManager() ?: return
        imm.showSoftInput(this, 0)
        // The IME may not be serving this view until focus settles; ask again on the next frame.
        post { if (isFocused) imm.showSoftInput(this, 0) }
    }

    private fun inputMethodManager(): InputMethodManager? = context.getSystemService(InputMethodManager::class.java)

    override fun onFocusChanged(gainFocus: Boolean, direction: Int, previouslyFocusedRect: Rect?) {
        super.onFocusChanged(gainFocus, direction, previouslyFocusedRect)
        state?.isFocused = gainFocus
        if (gainFocus) {
            restartBlink()
            state?.notifyInteraction()
        } else {
            stopBlink()
            inputConnection?.finishComposingText()
            setComposing("")
        }
        invalidate()
    }

    override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
        super.onWindowFocusChanged(hasWindowFocus)
        if (hasWindowFocus) restartBlink() else stopBlink()
        invalidate()
    }

    override fun onAttachedToWindow() {
        super.onAttachedToWindow()
        if (state?.takeFocusRequest() == true) post { requestTerminalFocus(showKeyboard = true) }
    }

    override fun onDetachedFromWindow() {
        super.onDetachedFromWindow()
        stopBlink()
        stopFlings()
        finishSelectionUi()
        removeCallbacks(syncFallback)
        syncFallbackPosted = false
    }

    private fun restartBlink() {
        removeCallbacks(blinkTick)
        cursorBlinkOn = true
        if (isFocused && isAttachedToWindow && hasWindowFocus()) postDelayed(blinkTick, CURSOR_BLINK_MS)
        invalidate()
    }

    private fun stopBlink() {
        removeCallbacks(blinkTick)
        cursorBlinkOn = true
    }

    override fun onCheckIsTextEditor(): Boolean = true

    override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection {
        outAttrs.inputType =
            when (inputMode) {
                TerminalInputMode.Raw -> InputType.TYPE_NULL
                TerminalInputMode.Text ->
                    InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS
                TerminalInputMode.Prose -> InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
            }
        // No fullscreen/extract UI; Enter is a key, not an action; terminal input never trains the
        // keyboard (it may be a password or a secret) except in prose mode.
        var options = EditorInfo.IME_FLAG_NO_FULLSCREEN or EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_ENTER_ACTION
        if (inputMode != TerminalInputMode.Prose) options = options or EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING
        outAttrs.imeOptions = options
        outAttrs.initialSelStart = 0
        outAttrs.initialSelEnd = 0
        return TerminalInputConnection(this, inputMode).also { inputConnection = it }
    }

    /** Text committed by the IME (latched modifiers apply to its first character). */
    internal fun typeText(text: CharSequence) {
        val st = state ?: return
        if (text.isEmpty()) return
        val bytes = TerminalKeys.encodeTyped(text, ctrl = st.ctrlLatched, alt = st.altLatched)
        st.consumeLatches()
        st.userInput(bytes)
    }

    internal fun sendBackspaces(count: Int) {
        if (count > 0) state?.userInput(ByteArray(count) { 0x7f })
    }

    internal fun sendEnter() {
        state?.userInput(TerminalKeys.ENTER)
    }

    internal fun pasteText(text: String) {
        state?.paste(text)
    }

    internal fun setComposing(text: String) {
        if (composing == text) return
        composing = text
        invalidate()
    }

    override fun onKeyPreIme(keyCode: Int, event: KeyEvent): Boolean {
        if (keyCode == KeyEvent.KEYCODE_BACK && state?.selection?.active == true) {
            if (event.action == KeyEvent.ACTION_UP) state?.clearSelection()
            return true
        }
        return super.onKeyPreIme(keyCode, event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        val st = state ?: return super.onKeyDown(keyCode, event)
        // Terminal copy/paste on a hardware keyboard (Ctrl+C / Ctrl+V go to the program).
        if (event.isCtrlPressed && event.isShiftPressed && !event.isAltPressed) {
            when (keyCode) {
                KeyEvent.KEYCODE_C -> {
                    copySelection()
                    return true
                }
                KeyEvent.KEYCODE_V -> {
                    pasteFromClipboard()
                    return true
                }
            }
        }
        if (event.isSystem || KeyEvent.isModifierKey(keyCode)) return super.onKeyDown(keyCode, event)
        val e = st.emulator
        val bytes =
            st.keyEncoder.encode(event, st.ctrlLatched, st.altLatched, e.isCursorKeysApplicationMode, e.isKeypadApplicationMode)
                ?: return super.onKeyDown(keyCode, event)
        st.consumeLatches()
        if (bytes.isNotEmpty()) st.userInput(bytes) else invalidate()
        return true
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean =
        if (state == null || event.isSystem || KeyEvent.isModifierKey(keyCode)) super.onKeyUp(keyCode, event) else true

    @Suppress("DEPRECATION") // ACTION_MULTIPLE text still arrives from some IMEs and devices.
    override fun onKeyMultiple(keyCode: Int, repeatCount: Int, event: KeyEvent): Boolean {
        val characters = event.characters
        if (keyCode == KeyEvent.KEYCODE_UNKNOWN && characters != null) {
            typeText(characters)
            return true
        }
        return super.onKeyMultiple(keyCode, repeatCount, event)
    }

    // endregion

    override fun onInitializeAccessibilityNodeInfo(info: AccessibilityNodeInfo) {
        super.onInitializeAccessibilityNodeInfo(info)
        info.className = "android.widget.EditText"
        state?.let { info.text = it.visibleText() }
    }

    private companion object {
        const val CURSOR_BLINK_MS = 530L
        const val SYNC_OUTPUT_TIMEOUT_MS = 150L
        const val WHEEL_TICK_MS = 16L
        const val INDICATOR_HOLD_MS = 700L
        const val INDICATOR_FADE_MS = 300L
        const val HANDLE_RADIUS_DP = 7f
        const val HANDLE_TOUCH_DP = 28f

        const val AXIS_NONE = 0
        const val AXIS_X = 1
        const val AXIS_Y = 2

        const val HANDLE_NONE = 0
        const val HANDLE_START = 1
        const val HANDLE_END = 2

        const val MENU_COPY = 1
        const val MENU_SELECT_ALL = 2
        const val MENU_PASTE = 3

        fun isNightMode(context: Context): Boolean =
            (context.resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES
    }
}
