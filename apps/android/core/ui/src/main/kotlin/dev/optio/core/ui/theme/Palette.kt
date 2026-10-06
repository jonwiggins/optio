package dev.optio.core.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.ui.graphics.Color

/**
 * Raw ARGB values of the one status palette (iOS `Shared/StatusColor.swift`), for surfaces that
 * cannot read Compose theme state: Glance widgets (`ColorProvider(day, night)`), notifications,
 * tiles. In Compose use [StatusColor] / [Tone] instead, which pick the right variant for the theme.
 *
 * purple = working, yellow = needs input, green = completed, grey = dead / idle, red = failed.
 */
object StatusPalette {
    /** #6d28d9 — working / running. The same value in light and dark, as on iOS. */
    const val PURPLE: Long = 0xFF6D28D9
    const val PURPLE_DARK: Long = 0xFFB49AF7

    /** Needs input: amber in light mode so it survives as text on white (0.80, 0.56, 0.0). */
    const val YELLOW_LIGHT: Long = 0xFF995B12

    /** Needs input: system yellow in dark mode (1.0, 0.84, 0.04). */
    const val YELLOW_DARK: Long = 0xFFFFD60A

    /** Completed / merged / healthy, light (0.13, 0.62, 0.28). */
    const val GREEN_LIGHT: Long = 0xFF087F5B

    /** Completed / merged / healthy, dark (0.19, 0.82, 0.35). */
    const val GREEN_DARK: Long = 0xFF30D159

    /** Dead / exited / idle: iOS `tertiaryLabel`, light (#3c3c43 at 30%). */
    const val GREY_LIGHT: Long = 0xFF77717E

    /** Dead / exited / idle: iOS `tertiaryLabel`, dark (#ebebf5 at 30%). */
    const val GREY_DARK: Long = 0xFF96909F

    /** Failed / error: iOS `systemRed`, light. */
    const val RED_LIGHT: Long = 0xFFFF3B30

    /** Failed / error: iOS `systemRed`, dark. */
    const val RED_DARK: Long = 0xFFFF453A
}

/**
 * Optio's colour tokens beyond the Material 3 scheme: the iOS label / fill hierarchy, the grouped
 * page and card surfaces, and the status palette, resolved for one appearance. Read them with
 * `OptioTheme.colors`.
 *
 * Text: [label] (primary), [secondaryLabel], [tertiaryLabel], [quaternaryLabel] are the iOS label
 * colours, translucent so they sit correctly on any surface. Fills ([fillSecondary],
 * [fillTertiary], [fillQuaternary]) are the translucent inset surfaces: code blocks, tool-call
 * bodies, capsules, meter tracks. Never nest a fill inside another fill.
 *
 * Surfaces: [page] is the grouped page, [card] the one card colour on it (iOS
 * `systemGroupedBackground` / `secondarySystemGroupedBackground`).
 */
@Immutable
data class OptioColors(
    val isDark: Boolean,
    /** The brand purple for interactive accents (Retry, send, links). Equals `colorScheme.primary`. */
    val accent: Color,
    val label: Color,
    val secondaryLabel: Color,
    val tertiaryLabel: Color,
    val quaternaryLabel: Color,
    val fill: Color,
    val fillSecondary: Color,
    val fillTertiary: Color,
    val fillQuaternary: Color,
    val page: Color,
    val card: Color,
    /** Hairline between rows and around nothing else. */
    val separator: Color,
    val purple: Color,
    val yellow: Color,
    val green: Color,
    val grey: Color,
    val red: Color,
    /** Surfaces one level up (sheets, dialogs' content): see [elevated]. */
    private val elevatedPage: Color,
    private val elevatedCard: Color,
) {
    /**
     * The same tokens for content on a raised surface (a bottom sheet): iOS draws a sheet's grouped
     * page one step lighter in dark mode, and its cards one step lighter again. Provide it with
     * `ProvideElevatedSurfaces { … }`.
     */
    fun elevated(): OptioColors = copy(page = elevatedPage, card = elevatedCard)

    companion object {
        val Light = OptioColors(
            isDark = false,
            accent = Color(0xFF6D28D9),
            label = Color(0xFF211F25),
            secondaryLabel = Color(0xFF655F6D),
            tertiaryLabel = Color(0xFF77717E),
            quaternaryLabel = Color(0x2E3C3C43),
            fill = Color(0x33787880),
            fillSecondary = Color(0x29787880),
            fillTertiary = Color(0x1F767680),
            fillQuaternary = Color(0x14747480),
            page = Color(0xFFF6F5F3),
            card = Color(0xFFFFFFFF),
            separator = Color(0xFFE7E4EB),
            purple = Color(StatusPalette.PURPLE),
            yellow = Color(StatusPalette.YELLOW_LIGHT),
            green = Color(StatusPalette.GREEN_LIGHT),
            grey = Color(StatusPalette.GREY_LIGHT),
            red = Color(StatusPalette.RED_LIGHT),
            elevatedPage = Color(0xFFF6F5F3),
            elevatedCard = Color(0xFFFFFFFF),
        )

        val Dark = OptioColors(
            isDark = true,
            accent = Color(0xFFB49AF7),
            label = Color(0xFFFFFFFF),
            secondaryLabel = Color(0xFFC0B9C9),
            tertiaryLabel = Color(0xFF96909F),
            quaternaryLabel = Color(0x29EBEBF5),
            fill = Color(0x5C787880),
            fillSecondary = Color(0x52787880),
            fillTertiary = Color(0x3D767680),
            fillQuaternary = Color(0x2E767680),
            page = Color(0xFF17151A),
            card = Color(0xFF211F25),
            separator = Color(0xFF36313D),
            purple = Color(StatusPalette.PURPLE_DARK),
            yellow = Color(StatusPalette.YELLOW_DARK),
            green = Color(StatusPalette.GREEN_DARK),
            grey = Color(StatusPalette.GREY_DARK),
            red = Color(StatusPalette.RED_DARK),
            elevatedPage = Color(0xFF211F25),
            elevatedCard = Color(0xFF2C2734),
        )
    }
}
