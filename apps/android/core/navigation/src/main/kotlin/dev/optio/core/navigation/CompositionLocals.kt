package dev.optio.core.navigation

import androidx.compose.runtime.staticCompositionLocalOf

/** The shell's [AppRouter]. Provided by `MainShell`; hubs and the shell read it. */
val LocalAppRouter = staticCompositionLocalOf<AppRouter> {
    error("No AppRouter: MainShell provides LocalAppRouter")
}

/** The [Navigator] features use. Defaults to [Navigator.None] so previews and screenshots work. */
val LocalNavigator = staticCompositionLocalOf<Navigator> { Navigator.None }
