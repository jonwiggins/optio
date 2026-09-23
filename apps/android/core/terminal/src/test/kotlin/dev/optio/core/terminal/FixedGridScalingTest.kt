package dev.optio.core.terminal

import android.app.Activity
import android.os.Looper
import android.view.ViewGroup
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import kotlin.math.ceil
import kotlin.math.roundToInt
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Robolectric
import org.robolectric.Shadows.shadowOf
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * The two grid modes' arithmetic: Fit's natural grid, and Fixed's "the owner's grid shrunk to fit"
 * (iOS `LocalTerminalHostView`), with the minimum-size clamp that leaves a wide grid to pan.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class FixedGridScalingTest {
    // A linear monospace: 0.6 em wide, 1.32 em tall (JetBrains Mono's proportions).
    private val linear: (Int) -> TerminalLayout.Cell = { px -> TerminalLayout.Cell(0.6f * px, ceil(1.32 * px).toInt()) }

    @Test
    fun naturalGridIsWhatFitsAtTheBaseFont() {
        val cell = TerminalLayout.Cell(18.9f, 42)
        assertEquals(TerminalGrid(56, 45), TerminalLayout.naturalGrid(1072f, 1900f, cell))
        // Never below Termux's 2 × 2.
        assertEquals(TerminalGrid(2, 2), TerminalLayout.naturalGrid(5f, 5f, cell))
    }

    @Test
    fun aLaptopGridOnAPhoneClampsAtTheMinimumAndOverflows() {
        // 1080 px wide phone at 2.625 dpi: base 12 dp = 32 px, min 5 dp = 13 px, max 20 dp = 53 px.
        val px = TerminalLayout.fixedTextSize(160, 45, 1080f, 1900f, basePx = 32, minPx = 13, maxPx = 53, cellAt = linear)
        assertEquals(13, px)
        assertTrue(160 * linear(px).width > 1080f, "a clamped grid is wider than the view: it pans")
    }

    @Test
    fun aGridThatFitsGetsTheLargestSizeThatFitsBothWays() {
        // Width: floor(1080 / (80 × 0.6)) = 22; height: floor(1900 / (24 × ~1.3125)) = 60 → 22.
        val px = TerminalLayout.fixedTextSize(80, 24, 1080f, 1900f, basePx = 32, minPx = 13, maxPx = 53, cellAt = linear)
        assertEquals(22, px)
        assertTrue(80 * linear(px).width <= 1080f)
        assertTrue(24 * linear(px).height <= 1900f)
    }

    @Test
    fun theRowsCanBeTheLimit() {
        // A tall grid in a short view (the keyboard is up): the height decides.
        val px = TerminalLayout.fixedTextSize(40, 30, 1080f, 900f, basePx = 32, minPx = 13, maxPx = 53, cellAt = linear)
        assertEquals(22, px)
        assertTrue(30 * linear(px).height <= 900f)
        assertTrue(30 * linear(px + 1).height > 900f)
        // Too many rows even at the minimum: clamped, and the grid pans vertically.
        assertEquals(13, TerminalLayout.fixedTextSize(40, 60, 1080f, 900f, 32, 13, 53, linear))
    }

    @Test
    fun aSmallGridGrowsButNotPastTheCap() {
        val px = TerminalLayout.fixedTextSize(20, 5, 1080f, 1900f, basePx = 32, minPx = 13, maxPx = 53, cellAt = linear)
        assertEquals(53, px)
    }

    @Test
    fun hintedMetricsThatOverflowStepDown() {
        // Cells hinted wider than linear at 22 px: 80 × 13.6 = 1088 > 1080, so 21.
        val hinted: (Int) -> TerminalLayout.Cell = { px ->
            TerminalLayout.Cell(if (px == 22) 13.6f else 0.6f * px, ceil(1.32 * px).toInt())
        }
        assertEquals(21, TerminalLayout.fixedTextSize(80, 24, 1080f, 1900f, 32, 13, 53, hinted))
    }

    // region With the bundled font, in a real view

    private fun layOut(mode: TerminalGridMode, width: Int = 1080, height: Int = 1900): Pair<TerminalState, OptioTerminalView> {
        val activity = Robolectric.buildActivity(Activity::class.java).setup().get()
        val state = TerminalState(mode)
        val view = OptioTerminalView(activity)
        view.state = state
        activity.setContentView(view, ViewGroup.LayoutParams(width, height))
        shadowOf(Looper.getMainLooper()).idle()
        return state to view
    }

    @Test
    fun fitUsesTheBaseFontAndFillsTheView() {
        val (state, view) = layOut(TerminalGridMode.Fit)
        val m = view.drawMetrics!!
        val density = view.resources.displayMetrics.density
        assertEquals((12 * density).roundToInt(), m.textSize)
        assertEquals((1080 / m.cellWidth).toInt(), state.grid.cols)
        assertEquals(1900 / m.lineHeight, state.grid.rows)
        assertEquals(state.grid, state.naturalGrid)
        assertEquals(0f, view.maxPanX)
    }

    @Test
    fun aFixedGridThatFitsIsScaledIntoTheView() {
        val (state, view) = layOut(TerminalGridMode.Fixed(80, 24))
        val m = view.drawMetrics!!
        assertEquals(TerminalGrid(80, 24), state.grid)
        assertTrue(80 * m.cellWidth <= 1080.5f, "cols fit: ${80 * m.cellWidth}")
        assertTrue(24 * m.lineHeight <= 1900, "rows fit")
        assertTrue(81 * m.cellWidth > 1080f * 0.93f, "and it uses the width: ${80 * m.cellWidth}")
        assertEquals(0f, view.maxPanX)
    }

    @Test
    fun aLaptopGridIsClampedAtFiveDpAndPans() {
        val (state, view) = layOut(TerminalGridMode.Fixed(160, 45))
        val m = view.drawMetrics!!
        val density = view.resources.displayMetrics.density
        assertEquals((5 * density).roundToInt(), m.textSize)
        assertEquals(TerminalGrid(160, 45), state.grid)
        assertTrue(view.maxPanX > 0f, "wider than the phone: pans")
    }

    @Test
    fun switchingModesRescalesWithoutTouchingTheNaturalGrid() {
        val (state, view) = layOut(TerminalGridMode.Fit)
        val natural = state.naturalGrid
        state.gridMode = TerminalGridMode.Fixed(120, 40)
        assertEquals(TerminalGrid(120, 40), state.grid)
        assertTrue(view.drawMetrics!!.textSize < (12 * view.resources.displayMetrics.density).roundToInt())
        state.gridMode = TerminalGridMode.Fit
        assertEquals(natural, state.grid)
    }

    // endregion
}
