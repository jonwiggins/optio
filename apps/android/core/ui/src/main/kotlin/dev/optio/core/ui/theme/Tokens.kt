package dev.optio.core.ui.theme

import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

// Design tokens (iOS `Core/UI/Tokens.swift`, docs/design/ios-ui-review.md §2). The palette is
// deliberately small: near-black type on flat grouped surfaces and one status palette.

/** Spacing scale. The screen gutter is [l]; stack spacing inside a row is [xs]. */
object Spacing {
    val xs: Dp = 4.dp
    val s: Dp = 8.dp
    val m: Dp = 12.dp
    val l: Dp = 16.dp
    val xl: Dp = 24.dp

    /** Vertical padding inside a list row (iOS `Spacing.row`; Android rows add the list inset). */
    val row: Dp = 6.dp

    /** Horizontal gutter of every screen. */
    val gutter: Dp = l
}

/**
 * Corner radii and their shapes. iOS draws every rounded rect as a continuous superellipse; Android
 * uses Material's rounded corners with the Material 3 shape scale (cards 16dp).
 */
object Radius {
    /** Badge-shaped rects, icon tiles, code chips. */
    val small: Dp = 8.dp

    /** Cards on the grouped page. */
    val card: Dp = 16.dp

    /** A rounded child inset by [Spacing.m] inside a card: concentric with the card corner. */
    val inner: Dp = maxOf(card - Spacing.m, small)

    /** Chat bubbles, composer fields, banners that stand alone. */
    val bubble: Dp = 18.dp

    val smallShape = RoundedCornerShape(small)
    val cardShape = RoundedCornerShape(card)
    val innerShape = RoundedCornerShape(inner)
    val bubbleShape = RoundedCornerShape(bubble)

    /** Badges, chips, toasts, meters. */
    val capsuleShape = RoundedCornerShape(percent = 50)
}

/** One categorical sequence for Analytics, Costs and Overview charts (iOS `ChartPalette`). */
object ChartPalette {
    /** accent, label at 55%, 30%, 15%. */
    val series: List<Color>
        @Composable @ReadOnlyComposable get() = series(OptioTheme.colors)

    fun series(colors: OptioColors): List<Color> = listOf(
        colors.accent,
        colors.label.copy(alpha = 0.55f),
        colors.label.copy(alpha = 0.3f),
        colors.label.copy(alpha = 0.15f),
    )

    @Composable
    @ReadOnlyComposable
    fun color(index: Int): Color = series[index.mod(4)]

    val primaryHeight: Dp = 160.dp
    val secondaryHeight: Dp = 96.dp

    /** Fill behind a single-series line. */
    const val AREA_ALPHA: Float = 0.12f
}
