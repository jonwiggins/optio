package dev.optio.feature.widgets.ui

import android.content.Context
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.glance.ColorFilter
import androidx.glance.GlanceModifier
import androidx.glance.Image
import androidx.glance.ImageProvider
import androidx.glance.color.ColorProvider as DayNight
import androidx.glance.layout.size
import androidx.glance.text.FontFamily
import androidx.glance.text.FontWeight
import androidx.glance.text.TextStyle
import androidx.glance.unit.ColorProvider
import dev.optio.core.data.ServerColor
import dev.optio.core.glance.GlanceIcon
import dev.optio.core.ui.theme.StatusKind
import dev.optio.feature.widgets.R
import java.time.Instant
import java.util.Date

/**
 * The widgets' visual language (iOS `GlanceStyle`, docs/design/ios-glanceable-surfaces.md §3):
 * neutral chrome, the one status palette (yellow = needs you, purple = working, green = done,
 * grey = idle, red = failed), one symbol and one word per row, names as path leaves, waits as "4m".
 *
 * Every colour is a day/night pair, so a widget follows the system's dark mode on its own. The
 * card and tile fills are colour resources (`optio_widgets_surface` / `optio_widgets_tile`, with
 * `values-night` variants) inside rounded drawables, which round on every API level.
 */
internal object WidgetColors {
    /** iOS `label`. */
    val label: ColorProvider = DayNight(day = Color(0xFF1C1C1E), night = Color(0xFFFFFFFF))

    /**
     * iOS `secondaryLabel`, composited over the card: opaque, because glyphs are tinted through
     * an image colour filter, which does not keep a translucent tint translucent.
     */
    val secondary: ColorProvider = DayNight(day = Color(0xFF8A8A8E), night = Color(0xFF98989F))

    /** iOS `tertiaryLabel`, composited over the card (opaque, as [secondary]). */
    val tertiary: ColorProvider = DayNight(day = Color(0xFFC4C4C6), night = Color(0xFF5B5B5F))

    /** Yellow: something needs you (amber on white, system yellow on dark). */
    val needsYou: ColorProvider = status(StatusKind.NEEDS_INPUT)

    /** Purple: agents are working. */
    val working: ColorProvider = status(StatusKind.WORKING)

    fun status(kind: StatusKind): ColorProvider = DayNight(day = Color(kind.argb(dark = false)), night = Color(kind.argb(dark = true)))

    /** The colour of a state's dot / word. */
    fun forState(state: String): ColorProvider = status(StatusKind.forState(state))

    /** A paired server's identity colour (the same in light and dark, as on iOS). */
    fun server(color: ServerColor): ColorProvider = DayNight(day = Color(color.argb), night = Color(color.argb))
}

/** Type roles in sp (iOS Dynamic Type defaults). */
internal object WidgetType {
    fun style(
        size: TextUnit,
        color: ColorProvider = WidgetColors.label,
        weight: FontWeight = FontWeight.Normal,
        mono: Boolean = false,
    ): TextStyle = TextStyle(color = color, fontSize = size, fontWeight = weight, fontFamily = if (mono) FontFamily.Monospace else null)

    val caption2: TextUnit = 11.sp
    val footnote: TextUnit = 13.sp
    val subheadline: TextUnit = 14.sp
    val headline: TextUnit = 17.sp
    val title: TextUnit = 28.sp
    val count: TextUnit = 44.sp
}

/** The drawable for a glance glyph (iOS SF Symbols → Material Symbols, lucide for git glyphs). */
internal fun GlanceIcon.drawable(): Int =
    when (this) {
        GlanceIcon.PLAY -> R.drawable.widget_ic_play
        GlanceIcon.CPU -> R.drawable.widget_ic_cpu
        GlanceIcon.CLOCK -> R.drawable.widget_ic_clock
        GlanceIcon.LAPTOP -> R.drawable.widget_ic_laptop
        GlanceIcon.SERVER -> R.drawable.widget_ic_server
        GlanceIcon.TERMINAL -> R.drawable.widget_ic_terminal
        GlanceIcon.BOLT -> R.drawable.widget_ic_bolt
        GlanceIcon.EXIT -> R.drawable.widget_ic_exit
        GlanceIcon.HAND -> R.drawable.widget_ic_hand
        GlanceIcon.BUBBLE -> R.drawable.widget_ic_bubble
        GlanceIcon.SLEEP -> R.drawable.widget_ic_zzz
        GlanceIcon.BELL -> R.drawable.widget_ic_bell
        GlanceIcon.CHECK -> R.drawable.widget_ic_check_filled
        GlanceIcon.ATTENTION -> R.drawable.widget_ic_alert_bubble
        GlanceIcon.MERGE -> R.drawable.widget_ic_merge
        GlanceIcon.WARNING -> R.drawable.widget_ic_triangle
        GlanceIcon.FAILED -> R.drawable.widget_ic_x_filled
        GlanceIcon.PULL_REQUEST -> R.drawable.widget_ic_pull
    }

/** A tinted glyph (every drawable in this module is white, so the tint is its colour). */
@Composable
internal fun Glyph(
    drawable: Int,
    color: ColorProvider,
    size: Dp,
    modifier: GlanceModifier = GlanceModifier,
    contentDescription: String? = null,
) {
    Image(
        provider = ImageProvider(drawable),
        contentDescription = contentDescription,
        colorFilter = ColorFilter.tint(color),
        modifier = modifier.size(size),
    )
}

/** A filled dot: a row's state, a server's identity. */
@Composable
internal fun Dot(
    color: ColorProvider,
    size: Dp = 7.dp,
    modifier: GlanceModifier = GlanceModifier,
    contentDescription: String? = null,
) {
    Glyph(R.drawable.widget_dot, color, size, modifier, contentDescription)
}

/** "4:40 PM" / "16:40" per the device's 12/24-hour setting. */
internal fun Context.shortTime(instant: Instant): String = android.text.format.DateFormat.getTimeFormat(this).format(Date.from(instant))

/**
 * [text] cut to [maxChars] from the front ("…Pro · web"), so a path's leaf survives (iOS
 * `truncationMode(.head)`); Glance text can only ellipsize at the end.
 */
internal fun truncateHead(
    text: String,
    maxChars: Int,
): String =
    when {
        maxChars <= 1 -> if (text.isEmpty()) "" else "…"
        text.length <= maxChars -> text
        else -> "…" + text.takeLast(maxChars - 1)
    }
