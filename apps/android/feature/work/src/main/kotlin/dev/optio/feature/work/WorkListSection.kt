package dev.optio.feature.work

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.ExtendedFloatingActionButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalAppRouter
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.hub.HubFab
import kotlinx.coroutines.launch

/**
 * Work › All (iOS `WorkListView`, web `/work`): every kind of work — PR tasks, jobs, automations,
 * terminals, pod sessions, persistent agents — as rows with the same attributes. Views are saved
 * filters (Active by default); rows open the per-kind detail screens.
 *
 * - Polls while on screen and refreshes on row-changing `/ws/events` frames; pull to refresh.
 * - Selects the view the router holds in `pendingWorkView` (Overview tiles,
 *   `optio://section/work?view=recurring`, `optio://needs-you`) and clears it.
 * - Contributes a search action to the hub's top bar and the "New work" FAB (`NewWorkRoute`). The
 *   form's `showCreatedWork` lands on the created detail on top of this list; coming back here
 *   refreshes, so the new row is already in the list (iOS `.optioSessionCreated`).
 */
@Composable
fun WorkListSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val router = LocalAppRouter.current
    val navigator = LocalNavigator.current
    val vm = viewModel { WorkListViewModel(api, hub.events, initialView = router.pendingWorkView ?: WorkView.ACTIVE) }
    val state by vm.state.collectAsStateWithLifecycle()
    val view by vm.view.collectAsStateWithLifecycle()
    val query by vm.query.collectAsStateWithLifecycle()
    val searching by vm.searching.collectAsStateWithLifecycle()
    val refreshing by vm.refreshing.collectAsStateWithLifecycle()
    val listState = rememberLazyListState()
    val scope = rememberCoroutineScope()

    // A new view starts at the top; coming back from a detail keeps the scroll position.
    fun show(next: WorkView) {
        if (next == vm.view.value) return
        vm.select(next)
        scope.launch { listState.scrollToItem(0) }
    }

    // Overview tiles and deep links park the view to show on the router.
    val pending = router.pendingWorkView
    LaunchedEffect(pending) {
        if (pending != null) {
            show(pending)
            router.pendingWorkView = null
        }
    }
    // iOS `onAppear { model.start() }` / `onDisappear { model.stop() }`, plus the app going to the background.
    LifecycleStartEffect(vm) {
        vm.start()
        onStopOrDispose { vm.stop() }
    }

    HubActions {
        val open = searching || query.isNotEmpty()
        IconButton(onClick = vm::toggleSearch, modifier = Modifier.testTag("work-search-toggle")) {
            Icon(if (open) Icons.Outlined.Close else Icons.Outlined.Search, contentDescription = if (open) "Close search" else "Search")
        }
    }
    val atTop by remember { derivedStateOf { listState.firstVisibleItemIndex == 0 } }
    // Viewers are read-only: no way into the form (its submit would only 403).
    val canMutate = Roles.canMutate
    if (canMutate) {
        HubFab {
            ExtendedFloatingActionButton(
                onClick = { navigator.push(NewWorkRoute()) },
                expanded = atTop,
                icon = { Icon(Icons.Filled.Add, contentDescription = null) },
                text = { Text("New work") },
                modifier = Modifier.testTag("new-work"),
            )
        }
    }

    WorkListContent(
        state = state,
        view = view,
        query = query,
        searching = searching,
        refreshing = refreshing,
        contentPadding = contentPadding,
        onSelectView = ::show,
        onQueryChange = vm::setQuery,
        onClearSearch = { vm.setQuery("") },
        onRefresh = vm::refresh,
        onOpen = { row -> navigator.push(row.destination.route()) },
        onOpenPr = navigator::openExternal,
        onNewWork = if (canMutate) ({ navigator.push(NewWorkRoute()) }) else null,
        modifier = modifier,
        listState = listState,
    )
}
