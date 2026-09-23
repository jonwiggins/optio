package dev.optio.core.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.runtime.Immutable
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.em
import androidx.compose.ui.unit.sp

/**
 * The app's text roles under their iOS names, so ported code reads the same
 * (`.font(.subheadline)` → `style = OptioTheme.type.subheadline`). Sizes follow the Material 3
 * scale (iOS points run about one step larger than Android sp); the hierarchy is iOS's. Read with
 * `OptioTheme.type`. Material components keep using `MaterialTheme.typography`.
 *
 * Roles (docs/design/ios-ui-review.md §2): row title = [body]; row meta = [subheadline] secondary;
 * row tertiary = [footnote]; section header = [sectionHeader]; stat value = [statValue]; badge =
 * [badge] (the only uppercase text). Mono ([monoSubheadline], [monoFootnote], [monoCaption]) only
 * for paths, branches, PR numbers, slugs, cron, JSON and logs — never prose, status words or cost.
 */
@Immutable
data class OptioTextStyles(
    val largeTitle: TextStyle,
    val title: TextStyle,
    val title2: TextStyle,
    val title3: TextStyle,
    val headline: TextStyle,
    val body: TextStyle,
    val callout: TextStyle,
    val subheadline: TextStyle,
    val footnote: TextStyle,
    val caption: TextStyle,
    val caption2: TextStyle,
    /** Footnote semibold, sentence case (`Font.sectionHeader`). */
    val sectionHeader: TextStyle,
    /** Title2 semibold with tabular digits (`Font.statValue`). */
    val statValue: TextStyle,
    /** Caption2 semibold, uppercase by the badge itself. */
    val badge: TextStyle,
    val monoBody: TextStyle,
    val monoSubheadline: TextStyle,
    val monoFootnote: TextStyle,
    val monoCaption: TextStyle,
) {
    companion object {
        /** Tabular (monospaced) digits, iOS `.monospacedDigit()`. */
        const val TABULAR_NUMS = "tnum"

        val Default: OptioTextStyles = run {
            fun style(size: Int, line: Int, weight: FontWeight = FontWeight.Normal, tracking: Double = 0.0) =
                TextStyle(fontSize = size.sp, lineHeight = line.sp, fontWeight = weight, letterSpacing = tracking.em)
            val footnote = style(13, 18)
            OptioTextStyles(
                largeTitle = style(32, 40, FontWeight.Bold),
                title = style(26, 32, FontWeight.SemiBold),
                title2 = style(22, 28),
                title3 = style(20, 25),
                headline = style(16, 22, FontWeight.SemiBold),
                body = style(16, 22),
                callout = style(15, 20),
                subheadline = style(14, 19),
                footnote = footnote,
                caption = style(12, 16),
                caption2 = style(11, 13, tracking = 0.01),
                sectionHeader = footnote.copy(fontWeight = FontWeight.SemiBold),
                statValue = style(22, 28, FontWeight.SemiBold).copy(fontFeatureSettings = TABULAR_NUMS),
                badge = style(11, 13, FontWeight.SemiBold, tracking = 0.04),
                monoBody = style(15, 21).copy(fontFamily = FontFamily.Monospace),
                monoSubheadline = style(14, 19).copy(fontFamily = FontFamily.Monospace),
                monoFootnote = style(12, 17).copy(fontFamily = FontFamily.Monospace),
                monoCaption = style(11, 15).copy(fontFamily = FontFamily.Monospace),
            )
        }
    }
}

/** Convenience modifiers on a [TextStyle], mirroring SwiftUI's font modifiers. */
fun TextStyle.semibold(): TextStyle = copy(fontWeight = FontWeight.SemiBold)

fun TextStyle.medium(): TextStyle = copy(fontWeight = FontWeight.Medium)

fun TextStyle.italic(): TextStyle = copy(fontStyle = FontStyle.Italic)

fun TextStyle.mono(): TextStyle = copy(fontFamily = FontFamily.Monospace)

/** iOS `.monospacedDigit()`: tabular figures so polling numbers don't jitter. */
fun TextStyle.tabularNums(): TextStyle = copy(fontFeatureSettings = OptioTextStyles.TABULAR_NUMS)

/**
 * Material 3's type scale with semibold titles (the "editorial" weight iOS gives titles), used by
 * Material components (top app bars, dialogs, buttons, chips).
 */
internal val OptioTypography: Typography = Typography().run {
    copy(
        headlineLarge = headlineLarge.copy(fontWeight = FontWeight.SemiBold),
        headlineMedium = headlineMedium.copy(fontWeight = FontWeight.SemiBold),
        headlineSmall = headlineSmall.copy(fontWeight = FontWeight.SemiBold),
        titleLarge = titleLarge.copy(fontWeight = FontWeight.SemiBold),
    )
}
