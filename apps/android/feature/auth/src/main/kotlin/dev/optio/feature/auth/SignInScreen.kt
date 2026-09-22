package dev.optio.feature.auth

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.PlaceholderScreen

/** How the sign-in form is used (iOS `SignInView(mode:)`). */
enum class SignInMode {
    /** No server paired yet: the whole app is this screen. */
    FIRST,

    /** Pair another server from the signed-in app ([dev.optio.core.navigation.routes.AddServerRoute]). */
    ADD,
}

/** Pair a server with its URL + personal access token (iOS `SignInView`). Stub: Agent C builds it. */
@Composable
fun SignInScreen(
    mode: SignInMode,
    modifier: Modifier = Modifier,
) {
    val navigator = LocalNavigator.current
    PlaceholderScreen(
        title = if (mode == SignInMode.ADD) "Add server" else "Sign in",
        detail = "SignInScreen(mode=$mode)",
        modifier = modifier,
        onBack = if (mode == SignInMode.ADD) navigator::pop else null,
    )
}
