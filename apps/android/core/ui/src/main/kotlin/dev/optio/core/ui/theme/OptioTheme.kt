package dev.optio.core.ui.theme

import androidx.compose.material3.ColorScheme
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/** Optio's accent (#6d28d9, iOS `AppTheme.accent`): interactive accents, the FAB, selection. */
val OptioPurple = Color(0xFF6D28D9)

/**
 * Light Material 3 scheme built from the iOS tokens: neutral grouped chrome (page #f2f2f7, cards
 * white), the brand purple as `primary`, iOS red as `error`, the needs-you amber as `tertiary`.
 * `secondaryContainer` (navigation indicator, selected segment, tonal buttons) is a neutral fill
 * and `onSecondaryContainer` the brand purple, the way iOS tints a selected tab or a bordered
 * button while its chrome stays grey.
 */
val OptioLightColorScheme: ColorScheme = lightColorScheme(
    primary = OptioPurple,
    onPrimary = Color.White,
    primaryContainer = Color(0xFFEDE9FE),
    onPrimaryContainer = Color(0xFF3B0F8C),
    inversePrimary = Color(0xFFC4B5FD),
    secondary = Color(0xFF5E5E63),
    onSecondary = Color.White,
    secondaryContainer = Color(0xFFE3E3E8),
    onSecondaryContainer = OptioPurple,
    tertiary = Color(StatusPalette.YELLOW_LIGHT),
    onTertiary = Color(0xFF1C1C1E),
    tertiaryContainer = Color(0xFFFFF1CC),
    onTertiaryContainer = Color(0xFF5C4200),
    background = Color(0xFFF2F2F7),
    onBackground = Color(0xFF1C1C1E),
    surface = Color(0xFFF2F2F7),
    onSurface = Color(0xFF1C1C1E),
    surfaceVariant = Color(0xFFE5E5EA),
    onSurfaceVariant = Color(0xFF6C6C70),
    surfaceTint = Color(0xFF8E8E93),
    inverseSurface = Color(0xFF2C2C2E),
    inverseOnSurface = Color(0xFFF2F2F7),
    error = Color(StatusPalette.RED_LIGHT),
    onError = Color.White,
    errorContainer = Color(0xFFFFE4E1),
    onErrorContainer = Color(0xFF8E1B14),
    outline = Color(0xFF8E8E93),
    outlineVariant = Color(0xFFD1D1D6),
    scrim = Color.Black,
    surfaceBright = Color.White,
    surfaceDim = Color(0xFFDDDDE2),
    surfaceContainerLowest = Color.White,
    surfaceContainerLow = Color.White,
    surfaceContainer = Color(0xFFF7F7FA),
    surfaceContainerHigh = Color(0xFFEFEFF4),
    surfaceContainerHighest = Color(0xFFE6E6EB),
)

/**
 * Dark Material 3 scheme: black grouped page, #1c1c1e cards, a lifted violet (#a78bfa) as `primary`
 * because #6d28d9 is too dim for text and icons on black. The status palette keeps #6d28d9 for
 * working in both modes, exactly as iOS does.
 */
val OptioDarkColorScheme: ColorScheme = darkColorScheme(
    primary = Color(0xFFA78BFA),
    onPrimary = Color(0xFF2E1065),
    primaryContainer = Color(0xFF4C1D95),
    onPrimaryContainer = Color(0xFFEDE9FE),
    inversePrimary = OptioPurple,
    secondary = Color(0xFFAEAEB2),
    onSecondary = Color(0xFF1C1C1E),
    secondaryContainer = Color(0xFF3A3A3C),
    onSecondaryContainer = Color(0xFFC4B5FD),
    tertiary = Color(StatusPalette.YELLOW_DARK),
    onTertiary = Color(0xFF332900),
    tertiaryContainer = Color(0xFF4D3F00),
    onTertiaryContainer = Color(0xFFFFE67A),
    background = Color.Black,
    onBackground = Color.White,
    surface = Color.Black,
    onSurface = Color.White,
    surfaceVariant = Color(0xFF2C2C2E),
    onSurfaceVariant = Color(0xFFA1A1A6),
    surfaceTint = Color(0xFF8E8E93),
    inverseSurface = Color(0xFFF2F2F7),
    inverseOnSurface = Color(0xFF1C1C1E),
    error = Color(StatusPalette.RED_DARK),
    onError = Color.White,
    errorContainer = Color(0xFF5C1A16),
    onErrorContainer = Color(0xFFFFDAD6),
    outline = Color(0xFF7C7C80),
    outlineVariant = Color(0xFF38383A),
    scrim = Color.Black,
    surfaceBright = Color(0xFF2C2C2E),
    surfaceDim = Color.Black,
    surfaceContainerLowest = Color.Black,
    surfaceContainerLow = Color(0xFF1C1C1E),
    surfaceContainer = Color(0xFF1C1C1E),
    surfaceContainerHigh = Color(0xFF262628),
    surfaceContainerHighest = Color(0xFF2C2C2E),
)

internal val LocalOptioColors = staticCompositionLocalOf { OptioColors.Light }
internal val LocalOptioTextStyles = staticCompositionLocalOf { OptioTextStyles.Default }

/**
 * The app theme for an [appearance] (system / light / dark). The app passes the stored choice:
 * `OptioTheme(appearanceStore.collectAppearance()) { … }`.
 */
@Composable
fun OptioTheme(
    appearance: AppAppearance = AppAppearance.SYSTEM,
    content: @Composable () -> Unit,
) {
    OptioTheme(darkTheme = appearance.isDark(), content = content)
}

/**
 * The app theme with an explicit dark flag (screenshots, previews, Glance-adjacent surfaces):
 * the Material 3 scheme ([OptioLightColorScheme] / [OptioDarkColorScheme]), Optio's typography,
 * and the extended tokens under [OptioTheme.colors] / [OptioTheme.type].
 */
@Composable
fun OptioTheme(
    darkTheme: Boolean,
    content: @Composable () -> Unit,
) {
    val colors = if (darkTheme) OptioColors.Dark else OptioColors.Light
    MaterialTheme(
        colorScheme = if (darkTheme) OptioDarkColorScheme else OptioLightColorScheme,
        typography = OptioTypography,
    ) {
        CompositionLocalProvider(
            LocalOptioColors provides colors,
            LocalOptioTextStyles provides OptioTextStyles.Default,
            LocalContentColor provides colors.label,
            content = content,
        )
    }
}

/** Accessors for Optio's tokens inside [OptioTheme] (like `MaterialTheme.colorScheme`). */
object OptioTheme {
    /** Label / fill / surface / status colours for the current appearance. */
    val colors: OptioColors
        @Composable @ReadOnlyComposable get() = LocalOptioColors.current

    /** Text roles under their iOS names. */
    val type: OptioTextStyles
        @Composable @ReadOnlyComposable get() = LocalOptioTextStyles.current
}

/**
 * Re-provides the surface tokens one level up for content on a raised surface (a bottom sheet):
 * `OptioTheme.colors.page` becomes the sheet colour and `card` a step lighter in dark mode.
 */
@Composable
fun ProvideElevatedSurfaces(content: @Composable () -> Unit) {
    CompositionLocalProvider(LocalOptioColors provides LocalOptioColors.current.elevated(), content = content)
}
