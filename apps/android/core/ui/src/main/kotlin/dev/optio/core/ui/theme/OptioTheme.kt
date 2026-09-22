package dev.optio.core.ui.theme

import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.material3.lightColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.graphics.Color

/** Optio's accent (#6d28d9, iOS `AppTheme.accent`). Use sparingly: needs-you and selection. */
val OptioPurple = Color(0xFF6D28D9)

private val LightColors =
    lightColorScheme(
        primary = OptioPurple,
        onPrimary = Color.White,
        primaryContainer = Color(0xFFEDE9FE),
        onPrimaryContainer = Color(0xFF2E1065),
    )

// On dark surfaces #6d28d9 is too dim for text and icons, so dark mode lifts it to violet-400.
private val DarkColors =
    darkColorScheme(
        primary = Color(0xFFA78BFA),
        onPrimary = Color(0xFF2E1065),
        primaryContainer = Color(0xFF4C1D95),
        onPrimaryContainer = Color(0xFFEDE9FE),
    )

/**
 * The app theme. Minimal scaffold version: light/dark Material 3 schemes around [OptioPurple].
 * Agent U owns `:core:ui` and adds the appearance setting (system/light/dark), tokens and type.
 */
@Composable
fun OptioTheme(
    darkTheme: Boolean = isSystemInDarkTheme(),
    content: @Composable () -> Unit,
) {
    MaterialTheme(
        colorScheme = if (darkTheme) DarkColors else LightColors,
        content = content,
    )
}
