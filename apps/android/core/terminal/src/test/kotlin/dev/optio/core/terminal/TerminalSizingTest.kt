package dev.optio.core.terminal

import dev.optio.core.terminal.TerminalSizing.Mode
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Ports iOS `OptioTests/TerminalSizingTests.swift` (every case) and the web's
 * `components/local/sizing.test.ts` vectors.
 */
class TerminalSizingTest {
    private val s = TerminalSizing
    private val laptop = TerminalGrid(cols = 160, rows = 45)
    private val phone = TerminalGrid(cols = 45, rows = 30)

    // region passiveFontSize (iOS passiveFontPt)

    @Test
    fun shrinksFontSoOversizeGridFitsWidth() {
        // 390pt phone, 160-col laptop grid, 0.6 cell ratio → 4.06 → floored 4 → clamped to 5
        assertEquals(5.0, s.passiveFontSize(availableWidth = 390.0, cols = 160, cellWidthPerUnit = 0.6))
        // 1000pt, 120 cols → 13.8 → 13 (may grow past the 12pt base on a wide screen)
        assertEquals(13.0, s.passiveFontSize(availableWidth = 1000.0, cols = 120, cellWidthPerUnit = 0.6))
        // 600pt, 120 cols → 8.3 → 8
        assertEquals(8.0, s.passiveFontSize(availableWidth = 600.0, cols = 120, cellWidthPerUnit = 0.6))
        // Same arithmetic as the web at its 13px base.
        assertEquals(13.0, s.passiveFontSize(availableWidth = 1000.0, cols = 120, cellWidthPerUnit = 0.6, base = 13.0))
    }

    @Test
    fun growsToFillAWideScreenButNotPastTheCap() {
        // 393pt phone, 53-col laptop grid → 12.3 → the base size, as before.
        assertEquals(12.0, s.passiveFontSize(availableWidth = 393.0, cols = 53, cellWidthPerUnit = 0.6))
        // 669pt (a foldable open), 53 cols → 21.0 → capped at 20.
        assertEquals(20.0, s.passiveFontSize(availableWidth = 669.0, cols = 53, cellWidthPerUnit = 0.6))
        // 669pt, 80 cols → 13.9 → 13: fills the width instead of a third of it.
        assertEquals(13.0, s.passiveFontSize(availableWidth = 669.0, cols = 80, cellWidthPerUnit = 0.6))
        assertEquals(20.0, s.passiveFontSize(availableWidth = 1600.0, cols = 40, cellWidthPerUnit = 0.6))
    }

    @Test
    fun fallsBackToBaseOnDegenerateInput() {
        assertEquals(12.0, s.passiveFontSize(availableWidth = 0.0, cols = 120, cellWidthPerUnit = 0.6))
        assertEquals(12.0, s.passiveFontSize(availableWidth = 600.0, cols = 0, cellWidthPerUnit = 0.6))
        assertEquals(12.0, s.passiveFontSize(availableWidth = 600.0, cols = 120, cellWidthPerUnit = 0.0))
        assertEquals(12.0, s.passiveFontSize(availableWidth = Double.NaN, cols = 120, cellWidthPerUnit = 0.6))
    }

    @Test
    fun webVectorsAtThe13pxBaseThatNeverGrows() {
        // sizing.test.ts: the web never grows past its base (max = base = 13).
        fun web(width: Double, cols: Int, ratio: Double) =
            s.passiveFontSize(width, cols, ratio, base = 13.0, min = 5.0, max = 13.0)
        assertEquals(5.0, web(390.0, 160, 0.6))
        assertEquals(13.0, web(1000.0, 120, 0.6))
        assertEquals(8.0, web(600.0, 120, 0.6))
        assertEquals(13.0, web(1600.0, 40, 0.6)) // "never grows past the base size for a small grid"
        assertEquals(13.0, web(0.0, 120, 0.6))
        assertEquals(13.0, web(600.0, 0, 0.6))
        assertEquals(13.0, web(600.0, 120, 0.0))
    }

    @Test
    fun exactFitsDoNotLoseAColumnToRounding() {
        // 720 / (120 × 0.6) is exactly 10; float arithmetic must not floor it to 9.
        assertEquals(10.0, s.passiveFontSize(availableWidth = 720.0, cols = 120, cellWidthPerUnit = 0.6))
    }

    // endregion

    // region onGridAnnounced

    @Test
    fun staysUnclaimedWhenPtyMatchesNaturalFit() {
        assertEquals(Mode.Unclaimed, s.onGridAnnounced(Mode.Unclaimed, laptop, natural = laptop, sent = emptyList()))
    }

    @Test
    fun goesPassiveWhenAnotherViewersGridArrives() {
        assertEquals(Mode.Passive(phone), s.onGridAnnounced(Mode.Unclaimed, phone, natural = laptop, sent = emptyList()))
    }

    @Test
    fun keepsOwnershipWhenOwnRequestEchoes() {
        assertEquals(Mode.Owner, s.onGridAnnounced(Mode.Owner, laptop, natural = laptop, sent = listOf(laptop)))
    }

    @Test
    fun keepsOwnershipOnStaleEchoOfEarlierRequest() {
        val first = TerminalGrid(cols = 143, rows = 54)
        val second = TerminalGrid(cols = 143, rows = 56)
        var sent = s.pushSentGrid(emptyList(), first)
        sent = s.pushSentGrid(sent, second)
        assertEquals(Mode.Owner, s.onGridAnnounced(Mode.Owner, first, natural = second, sent = sent))
        sent = s.ackSentGrid(sent, first)!!
        assertEquals(listOf(second), sent)
        assertEquals(Mode.Owner, s.onGridAnnounced(Mode.Owner, second, natural = second, sent = sent))
        assertEquals(emptyList(), s.ackSentGrid(sent, second))
        // A grid we never asked for matches nothing.
        assertNull(s.ackSentGrid(sent, phone))
    }

    @Test
    fun capsPendingQueueWhenDaemonNeverEchoes() {
        var sent = emptyList<TerminalGrid>()
        for (i in 0 until 100) sent = s.pushSentGrid(sent, TerminalGrid(cols = 80 + i, rows = 24))
        assertEquals(32, sent.size)
        assertEquals(TerminalGrid(cols = 148, rows = 24), sent.first())
    }

    @Test
    fun losesOwnershipWhenSomeoneElseResizes() {
        assertEquals(Mode.Passive(phone), s.onGridAnnounced(Mode.Owner, phone, natural = laptop, sent = listOf(laptop)))
    }

    @Test
    fun returnsToUnclaimedWhenPtyComesBackToNaturalFit() {
        assertEquals(Mode.Unclaimed, s.onGridAnnounced(Mode.Passive(phone), laptop, natural = laptop, sent = emptyList()))
    }

    @Test
    fun pinsRecordedGridEvenWhenItMatchesNaturalFit() {
        assertEquals(Mode.Passive(laptop), s.onGridAnnounced(Mode.Unclaimed, laptop, natural = laptop, sent = emptyList(), recorded = true))
        assertEquals(Mode.Passive(laptop), s.onGridAnnounced(Mode.Owner, laptop, natural = laptop, sent = listOf(laptop), recorded = true))
    }

    @Test
    fun sameGridHandlesNulls() {
        // sizing.test.ts "sameGrid handles nulls".
        assertFalse(s.sameGrid(null, laptop))
        assertTrue(s.sameGrid(laptop, laptop.copy()))
    }

    // endregion

    @Test
    fun sizingModesMapToGridModes() {
        assertEquals(TerminalGridMode.Fit, Mode.Unclaimed.gridMode)
        assertEquals(TerminalGridMode.Fit, Mode.Owner.gridMode)
        assertEquals(TerminalGridMode.Fixed(160, 45), Mode.Passive(laptop).gridMode)
    }
}
