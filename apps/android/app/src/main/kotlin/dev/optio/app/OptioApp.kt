package dev.optio.app

import androidx.compose.animation.Crossfade
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
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
import dev.optio.core.ui.theme.AppearanceStore
import dev.optio.core.ui.theme.LocalAppearanceStore
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.collectAppearance
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.core.ui.toast.ToastHost
import dev.optio.core.ui.toast.rememberToaster
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.UsageStore
import dev.optio.core.ui.usage.rememberUsageStore
import dev.optio.feature.auth.SignInMode
import dev.optio.feature.auth.SignInScreen
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.filterNotNull

/**
 * Root composable: the auth gate (port of iOS `RootView`). Restoring → a progress screen; signed
 * out → the first-run [SignInScreen]; signed in → [MainShell] keyed on `session.generation`, so a
 * server switch rebuilds every screen with fresh state for the new instance.
 *
 * Provided to everything: [LocalSessionStore], [LocalAppearanceStore], [LocalToaster] (one
 * [ToastHost] over the whole app) and [LocalUsageStore] (one usage poller, outside the server
 * key: it drops its cache itself when the client is re-pointed). The signed-in shell also gets
 * [LocalApiClient], [LocalEventHub] and [LocalCurrentUser].
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun OptioApp(
    session: SessionStore = LocalAppGraph.current.session,
    deepLinks: DeepLinkInbox = LocalAppGraph.current.deepLinks,
    appearanceStore: AppearanceStore? = LocalAppGraph.current.appearanceStore,
    toasts: Flow<String> = LocalAppGraph.current.toasts,
) {
    OptioTheme(appearanceStore.collectAppearance()) {
        val toaster = rememberToaster()
        val usage = rememberUsageStore()
        LaunchedEffect(toaster, toasts) { toasts.collect { toaster.success(it) } }
        CompositionLocalProvider(
            LocalSessionStore provides session,
            LocalAppearanceStore provides appearanceStore,
            LocalToaster provides toaster,
            LocalUsageStore provides usage,
        ) {
            val phase by session.phase.collectAsStateWithLifecycle()
            // testTags become resource-ids for uiautomator / adb-driven QA, sign-in included.
            Box(Modifier.fillMaxSize().semantics { testTagsAsResourceId = true }) {
                Crossfade(targetState = phase, label = "auth-gate") { current ->
                    when (current) {
                        SessionStore.Phase.RESTORING -> RestoringScreen()
                        SessionStore.Phase.SIGNED_OUT -> SignInScreen(SignInMode.FIRST)
                        SessionStore.Phase.SIGNED_IN -> SignedIn(session, deepLinks, usage)
                    }
                }
                ToastHost(toaster, Modifier.align(Alignment.BottomCenter).navigationBarsPadding().padding(bottom = 80.dp))
            }
        }
    }
}

/** iOS `ProgressView("Connecting…")`. */
@Composable
private fun RestoringScreen() {
    Surface(Modifier.fillMaxSize().testTag("restoring"), color = OptioTheme.colors.page) {
        Column(
            modifier = Modifier.fillMaxSize(),
            verticalArrangement = Arrangement.spacedBy(12.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            CircularProgressIndicator()
            Text("Connecting…", style = OptioTheme.type.subheadline, color = OptioTheme.colors.secondaryLabel)
        }
    }
}

@Composable
private fun SignedIn(
    session: SessionStore,
    deepLinks: DeepLinkInbox,
    usage: UsageStore,
) {
    val generation by session.generation.collectAsStateWithLifecycle()
    val user by session.user.collectAsStateWithLifecycle()
    // The one ApiClient is re-pointed on every switch: rebind (the store drops a stale cache).
    LaunchedEffect(usage, generation) { usage.bind(session.api) }
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
