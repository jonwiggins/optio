package dev.optio.core.terminal

import android.content.Context
import android.content.res.Resources
import android.graphics.Typeface
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import android.graphics.fonts.Font as PlatformFont
import android.graphics.fonts.FontFamily as PlatformFontFamily

/**
 * The terminal's fonts, both SIL Open Font License 1.1 and shipped with their licences under
 * `assets/licenses/`:
 *
 * - **JetBrains Mono NL** Regular (`res/font/jetbrains_mono_nl_regular.ttf`, the no-ligatures cut):
 *   the web terminal's font; covers all of box drawing (U+2500–257F) and block elements
 *   (U+2580–259F), and its line gap is 0, so box-drawing lines join into unbroken borders.
 * - **Noto Sans Symbols 2**, subset to the text symbols TUIs draw that JetBrains Mono lacks
 *   (`res/font/terminal_symbols.ttf`, 80 KB: Arrows, Misc Technical, Geometric Shapes, Dingbats,
 *   Braille). Android's own fonts render Claude Code's `⏺` as a colour emoji and `⏵` (as in
 *   "⏵⏵ accept edits on") not at all; with this fallback they draw like on a desktop terminal.
 *   Code points that default to emoji presentation (✅ ⭐ ⌛ ⏩ …) are left out, so they stay emoji.
 *
 * Anything else (CJK, emoji, other scripts) falls back to the system fonts.
 */
object TerminalFonts {
    @Volatile
    private var cached: Typeface? = null

    /** JetBrains Mono → the symbol subset → the system's monospace fallback chain. */
    fun typeface(context: Context): Typeface {
        cached?.let { return it }
        val built =
            runCatching { withSymbolFallback(context.resources) }.getOrNull()
                ?: runCatching { context.resources.getFont(R.font.jetbrains_mono_nl_regular) }.getOrNull()
                ?: return Typeface.MONOSPACE
        cached = built
        return built
    }

    private fun withSymbolFallback(resources: Resources): Typeface {
        val mono = PlatformFontFamily.Builder(PlatformFont.Builder(resources, R.font.jetbrains_mono_nl_regular).build()).build()
        val symbols = PlatformFontFamily.Builder(PlatformFont.Builder(resources, R.font.terminal_symbols).build()).build()
        return Typeface.CustomFallbackBuilder(mono)
            .addCustomFallback(symbols)
            .setSystemFallback("monospace")
            .build()
    }

    /** JetBrains Mono for Compose text (the key bar, chrome that should match the terminal). */
    val fontFamily: FontFamily = FontFamily(Font(R.font.jetbrains_mono_nl_regular))
}
