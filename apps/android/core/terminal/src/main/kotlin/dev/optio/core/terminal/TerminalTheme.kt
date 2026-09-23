package dev.optio.core.terminal

import androidx.compose.ui.graphics.Color
import com.termux.terminal.TerminalColors
import com.termux.terminal.TerminalEmulator
import com.termux.terminal.TextStyle

/**
 * Terminal colours that follow the app's light/dark appearance: a port of iOS `TerminalTheme.swift`.
 * The view applies the palette whenever its `dark` flag changes, so switching appearance re-themes
 * a live terminal without reconnecting. The cursor matches the text (no accent): the terminal is a
 * tool, not a brand surface.
 */
object TerminalTheme {
    // Canvas and text, as ARGB.
    private const val DARK_BACKGROUND = 0xFF09090B.toInt()
    private const val DARK_FOREGROUND = 0xFFF4F4F5.toInt()
    private const val LIGHT_BACKGROUND = 0xFFFAFAFA.toInt()
    private const val LIGHT_FOREGROUND = 0xFF18181B.toInt()

    /**
     * The 16 ANSI colours. Dark: a soft "zinc" palette; light: the same hues darkened so they stay
     * legible on a near-white background.
     */
    val darkAnsi: IntArray =
        argb(
            0x27272a, 0xf87171, 0x4ade80, 0xfacc15, 0x60a5fa, 0xc084fc, 0x22d3ee, 0xd4d4d8,
            0x52525b, 0xfca5a5, 0x86efac, 0xfde047, 0x93c5fd, 0xd8b4fe, 0x67e8f9, 0xfafafa,
        )
    val lightAnsi: IntArray =
        argb(
            0x18181b, 0xb91c1c, 0x15803d, 0xa16207, 0x1d4ed8, 0x6d28d9, 0x0e7490, 0x71717a,
            0x3f3f46, 0xdc2626, 0x16a34a, 0xca8a04, 0x2563eb, 0x7c3aed, 0x0891b2, 0x09090b,
        )

    /** Compose colour matching the terminal canvas, for chrome around it (strips, the key bar). */
    fun background(dark: Boolean): Color = Color(backgroundArgb(dark))

    /** Compose colour of plain terminal text. */
    fun foreground(dark: Boolean): Color = Color(foregroundArgb(dark))

    fun backgroundArgb(dark: Boolean): Int = if (dark) DARK_BACKGROUND else LIGHT_BACKGROUND

    fun foregroundArgb(dark: Boolean): Int = if (dark) DARK_FOREGROUND else LIGHT_FOREGROUND

    /** Selected cells: the brand purple, translucent so the text stays readable. */
    fun selectionArgb(dark: Boolean): Int = if (dark) 0x736D28D9 else 0x4D6D28D9

    /** Selection handles and the IME's composing underline. */
    const val ACCENT_ARGB: Int = 0xFF6D28D9.toInt()

    /**
     * The full indexed palette the renderer reads: the 16 ANSI colours above, xterm's 6×6×6 cube and
     * 24-step grey ramp for 16–255, then default foreground, background and cursor
     * ([TextStyle.COLOR_INDEX_FOREGROUND] …).
     */
    fun palette(dark: Boolean): IntArray {
        val p = IntArray(TextStyle.NUM_INDEXED_COLORS)
        (if (dark) darkAnsi else lightAnsi).copyInto(p)
        val levels = intArrayOf(0x00, 0x5f, 0x87, 0xaf, 0xd7, 0xff)
        for (i in 0 until 216) {
            val r = levels[i / 36]
            val g = levels[(i / 6) % 6]
            val b = levels[i % 6]
            p[16 + i] = (0xFF shl 24) or (r shl 16) or (g shl 8) or b
        }
        for (i in 0 until 24) {
            val v = 8 + 10 * i
            p[232 + i] = (0xFF shl 24) or (v shl 16) or (v shl 8) or v
        }
        p[TextStyle.COLOR_INDEX_FOREGROUND] = foregroundArgb(dark)
        p[TextStyle.COLOR_INDEX_BACKGROUND] = backgroundArgb(dark)
        p[TextStyle.COLOR_INDEX_CURSOR] = foregroundArgb(dark)
        return p
    }

    /**
     * Installs the palette as `emulator`'s current colours, and as Termux's process-wide default
     * scheme so a program's colour reset (`OSC 104`, `RIS`) comes back to this palette rather than
     * Termux's. The app has one appearance at a time, so the global default is always the right one.
     */
    fun apply(emulator: TerminalEmulator, dark: Boolean) {
        val p = palette(dark)
        p.copyInto(TerminalColors.COLOR_SCHEME.mDefaultColors)
        p.copyInto(emulator.mColors.mCurrentColors)
    }

    // Key bar chrome (iOS: a material/glass bar with `.fill.tertiary` key caps).
    internal fun keyBarArgb(dark: Boolean): Int = if (dark) 0xFF18181B.toInt() else 0xFFF4F4F5.toInt()

    internal fun keyCapArgb(dark: Boolean): Int = if (dark) 0xFF27272A.toInt() else 0xFFE4E4E7.toInt()

    internal fun keyCapPressedArgb(dark: Boolean): Int = if (dark) 0xFF3F3F46.toInt() else 0xFFD4D4D8.toInt()

    internal fun hairlineArgb(dark: Boolean): Int = if (dark) 0x1FFFFFFF else 0x1F000000

    private fun argb(vararg rgb: Int): IntArray = IntArray(rgb.size) { (0xFF shl 24) or rgb[it] }
}
