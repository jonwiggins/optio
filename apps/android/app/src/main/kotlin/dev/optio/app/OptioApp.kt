package dev.optio.app

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.app.shell.MainShell
import dev.optio.core.data.DeepLink
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.rememberAppRouter
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.network.LocalEventHub
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.auth.SignInMode
import dev.optio.feature.auth.SignInScreen
import kotlinx.coroutines.flow.filterNotNull

/**
 * Root composable: the auth gate (port of iOS `RootView`). Restoring → a progress screen; signed
 * out → the first-run [SignInScreen]; signed in → [MainShell] keyed on `session.generation`, so a
 * server switch rebuilds every screen with fresh state for the new instance. [LocalSessionStore]
 * wraps everything; the signed-in shell also gets [LocalApiClient], [LocalEventHub] and
 * [LocalCurrentUser].
 */
@Composable
fun OptioApp(
    session: SessionStore = LocalAppGraph.current.session,
    deepLinks: DeepLinkInbox = LocalAppGraph.current.deepLinks,
) {
    OptioTheme {
        CompositionLocalProvider(LocalSessionStore provides session) {
            val phase by session.phase.collectAsStateWithLifecycle()
            Crossfade(targetState = phase, label = "auth-gate") { current ->
                when (current) {
                    SessionStore.Phase.RESTORING -> RestoringScreen()
                    SessionStore.Phase.SIGNED_OUT -> SignInScreen(SignInMode.FIRST)
                    SessionStore.Phase.SIGNED_IN -> SignedIn(session, deepLinks)
                }
            }
        }
    }
}

/** iOS `ProgressView("Connecting…")`. */
@Composable
private fun RestoringScreen() {
    Surface(Modifier.fillMaxSize().testTag("restoring")) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator()
            Text("Connecting…", style = MaterialTheme.typography.bodyMedium, color = MaterialTheme.colorScheme.onSurfaceVariant)
        }
    }
}

@Composable
private fun SignedIn(
    session: SessionStore,
    deepLinks: DeepLinkInbox,
) {
    val generation by session.generation.collectAsStateWithLifecycle()
    val user by session.user.collectAsStateWithLifecycle()
    key(generation) {
        val router = rememberAppRouter()
        CompositionLocalProvider(
            LocalApiClient provides session.api,
            LocalEventHub provides session.events,
            LocalCurrentUser provides user,
        ) {
            DeepLinkRouting(router, session, deepLinks)
            MainShell(router = router, onOpenDeepLink = deepLinks::deliver)
        }
    }
}

/**
 * Routes links from [deepLinks] into [router] (iOS `MainTabView.handle(url:)` + `flushPendingURL`):
 * a link that names another paired server (`?server=<id>`) is stashed while the session switches
 * (which rebuilds this shell); the new shell flushes and routes it on the right server.
 */
@Composable
private fun DeepLinkRouting(
    router: AppRouter,
    session: SessionStore,
    deepLinks: DeepLinkInbox,
) {
    LaunchedEffect(router) {
        deepLinks.flushStash()
        deepLinks.pending.filterNotNull().collect { url ->
            if (!deepLinks.take(url)) return@collect
            val target = DeepLink.serverId(url)
            if (target != null && target != session.activeServer.value?.id && session.servers.value.any { it.id == target }) {
                deepLinks.stash(url)
                session.switchTo(target)
            } else {
                router.handle(url)
            }
        }
    }
}
