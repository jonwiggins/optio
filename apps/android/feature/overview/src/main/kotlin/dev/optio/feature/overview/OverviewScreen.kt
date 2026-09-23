package dev.optio.feature.overview

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.LocalLifecycleOwner
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.repeatOnLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.ServersRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.ObservesUsage
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/**
 * The Overview hub's content (iOS `Features/Overview`, a mirror of the web dashboard
 * `apps/web/src/app/page.tsx`). The hub chrome (title, server chip) comes from `:app`; this draws
 * the list and contributes Refresh and New work to the top bar.
 *
 * While on screen: the dashboard refreshes every 10 s, the Work board every 30 s and on
 * `/ws/events`, usage every minute (core:ui's shared `UsageStore`), and the other paired servers'
 * counts every 30 s, each fetched straight from that server with its own token.
 */
@Composable
fun OverviewScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val usage = LocalUsageStore.current
    val vm = viewModel {
        OverviewViewModel(
            api = api,
            events = hub.events,
            otherServers = OtherServersModel { server ->
                ServerGlances.load(server, session.client(server.id)?.let(ServerGlances::withGlanceTimeout))
            },
        )
    }
    val otherServers = vm.otherServers
    val dashboard by vm.dashboard.collectAsStateWithLifecycle()
    val feed by vm.feed.collectAsStateWithLifecycle()
    val glances by otherServers.glances.collectAsStateWithLifecycle()
    val active by session.activeServer.collectAsStateWithLifecycle()
    val servers by session.servers.collectAsStateWithLifecycle()
    val user by session.user.collectAsStateWithLifecycle()
    val switching by session.switching.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()

    ObservesUsage()
    // iOS `.task { … }` / `onAppear` / `onDisappear`, plus the app going to the background.
    LifecycleStartEffect(vm) {
        vm.start()
        onStopOrDispose { vm.stop() }
    }
    val others = servers.filter { it.id != active?.id }
    val lifecycle = LocalLifecycleOwner.current.lifecycle
    LaunchedEffect(others, lifecycle) {
        if (others.isEmpty()) return@LaunchedEffect
        lifecycle.repeatOnLifecycle(Lifecycle.State.STARTED) {
            while (true) {
                otherServers.refresh(others)
                delay(30.seconds)
            }
        }
    }

    HubActions {
        // The header's refresh: the dashboard, the board and (fresh) usage at once.
        IconButton(
            onClick = {
                scope.launch {
                    coroutineScope {
                        launch { usage?.refreshFresh() }
                        vm.refreshAll()
                    }
                }
            },
            modifier = Modifier.testTag("overview-refresh"),
        ) { Icon(Icons.Outlined.Refresh, contentDescription = "Refresh") }
        IconButton(onClick = { navigator.push(NewWorkRoute()) }, modifier = Modifier.testTag("overview-new-work")) {
            Icon(Icons.Filled.Add, contentDescription = "New work")
        }
    }

    val profile = active
    OverviewContent(
        dashboard = dashboard,
        feed = feed,
        server = profile?.let {
            ActiveServer(
                profile = it,
                userLabel = user?.displayName ?: user?.email,
                switching = switching,
                serverCount = servers.size,
            )
        },
        otherServers = if (others.isEmpty()) emptyList() else glances.filter { g -> others.any { it.id == g.server.id } },
        contentPadding = contentPadding,
        actions = remember(vm, navigator, session, usage) {
            OverviewActions(
                onRefresh = {
                    coroutineScope {
                        val limits = async { usage?.refresh() }
                        vm.refreshAll()
                        limits.await()
                    }
                },
                onRetry = { scope.launch { vm.refresh() } },
                onRetryFeed = { scope.launch { vm.refreshFeed() } },
                onOpenWork = { view -> navigator.open(Section.WORK, view) },
                onOpenSection = { section -> navigator.open(section) },
                onOpen = navigator::push,
                onOpenExternal = navigator::openExternal,
                onNewWork = { navigator.push(NewWorkRoute()) },
                onManageServers = { navigator.push(ServersRoute) },
                // The session's own scope finishes the switch although it rebuilds this shell.
                onSwitchServer = { id -> scope.launch { session.switchTo(id) } },
            )
        },
        modifier = modifier,
    )
}
