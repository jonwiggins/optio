package dev.optio.core.terminal

import android.content.Context
import android.graphics.Typeface
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily

/**
 * The terminal's monospace: JetBrains Mono NL (no ligatures) Regular, bundled under
 * `res/font/jetbrains_mono_nl_regular.ttf`. SIL Open Font License 1.1; the licence ships with the
 * app as `assets/licenses/JetBrainsMono-OFL.txt`. Chosen because the web terminal uses JetBrains
 * Mono too, it covers all of box drawing (U+2500–257F) and block elements (U+2580–259F), and its
 * line gap is 0, so box-drawing lines join into unbroken borders (Claude Code's panels). Glyphs it
 * lacks (braille spinners, ⏺ ⎿ ✻, CJK, emoji) fall back to the system fonts as usual.
 */
object TerminalFonts {
    @Volatile
    private var cached: Typeface? = null

    /** The bundled typeface, falling back to the system monospace if it can't be loaded. */
    fun typeface(context: Context): Typeface =
        cached ?: runCatching { context.resources.getFont(R.font.jetbrains_mono_nl_regular) }
            .getOrNull()
            ?.also { cached = it }
            ?: Typeface.MONOSPACE

    /** The same font for Compose text (the key bar, chrome that should match the terminal). */
    val fontFamily: FontFamily = FontFamily(Font(R.font.jetbrains_mono_nl_regular))
}
