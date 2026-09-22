package dev.optio.app

import androidx.compose.runtime.Composable
import dev.optio.app.shell.MainShell
import dev.optio.core.ui.theme.OptioTheme

/**
 * Root composable.
 *
 * TODO(C): auth gate (PLAN §4, port of iOS `RootView`): `SessionStore.phase` restoring → progress;
 * signedOut → `SignInScreen(SignInMode.FIRST)`; signedIn → `key(session.generation) { MainShell() }`
 * so a server switch rebuilds every screen. Until then the shell shows directly.
 */
@Composable
fun OptioApp() {
    OptioTheme {
        MainShell()
    }
}
