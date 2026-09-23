package dev.optio.app.shell

import androidx.activity.compose.BackHandler
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.LibraryBooks
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.snapshotFlow
import androidx.compose.ui.Alignment
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
import androidx.compose.ui.unit.dp
import androidx.lifecycle.viewmodel.navigation3.rememberViewModelStoreNavEntryDecorator
import androidx.navigation3.runtime.NavKey
import androidx.navigation3.runtime.rememberDecoratedNavEntries
import androidx.navigation3.runtime.rememberSaveableStateHolderNavEntryDecorator
import androidx.navigation3.ui.NavDisplay
import dev.optio.app.openExternalUrl
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.LocalAppRouter
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.RouterNavigator
import dev.optio.core.navigation.Tab
import dev.optio.core.navigation.rememberAppRouter
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.launch

/**
 * The signed-in shell (PLAN §4): a `NavigationSuiteScaffold` (bottom bar on phones, rail on wide
 * screens) with Overview · Work · Library · Insights · More, and one Navigation 3 back stack per
 * tab. Re-selecting the tab on screen pops it to its hub; Back at a hub other than Overview
 * returns to Overview.
 *
 * Every tab's entries stay decorated (saveable state + entry-scoped ViewModels) while another
 * tab is on screen, so switching tabs keeps each stack exactly as it was (like iOS). The whole
 * shell, and all of that state, is dropped when the root re-keys it on `session.generation` (a
 * server switch).
 *
 * [onOpenDeepLink] backs `Navigator.openDeepLink` (the root sends links through its server-aware
 * inbox); the router's `createdToast` shows as a snackbar above the navigation bar.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MainShell(
    modifier: Modifier = Modifier,
    router: AppRouter = rememberAppRouter(),
    onOpenDeepLink: (url: String) -> Unit = { router.handle(it) },
) {
    val context = LocalContext.current
    val currentOnOpenDeepLink by rememberUpdatedState(onOpenDeepLink)
    val navigator =
        remember(router, context) {
            RouterNavigator(
                router = router,
                onOpenDeepLink = { url -> currentOnOpenDeepLink(url) },
                onOpenExternal = { url -> context.openExternalUrl(url) },
            )
        }
    val entryProvider = remember { appEntryProvider() }
    val snackbarHostState = remember { SnackbarHostState() }
    LaunchedEffect(router) {
        snapshotFlow { router.createdToast }.filterNotNull().collect { toast ->
            router.consumeCreatedToast()
            launch { snackbarHostState.showSnackbar(toast) }
        }
    }

    CompositionLocalProvider(LocalAppRouter provides router, LocalNavigator provides navigator) {
        NavigationSuiteScaffold(
            modifier = modifier.semantics { testTagsAsResourceId = true },
            navigationSuiteItems = {
                Tab.entries.forEach { tab ->
                    item(
                        selected = tab == router.selectedTab,
                        onClick = { router.select(tab) },
                        icon = { Icon(tab.icon, contentDescription = null) },
                        label = { Text(tab.label) },
                        modifier = Modifier.testTag("tab-${tab.name.lowercase()}"),
                    )
                }
            },
        ) {
            val entriesByTab =
                Tab.entries.associateWith { tab ->
                    key(tab) {
                        rememberDecoratedNavEntries(
                            backStack = router.backStack(tab),
                            entryDecorators =
                                listOf(
                                    rememberSaveableStateHolderNavEntryDecorator<NavKey>(),
                                    rememberViewModelStoreNavEntryDecorator<NavKey>(),
                                ),
                            entryProvider = entryProvider,
                        )
                    }
                }
            val tab = router.selectedTab
            BackHandler(enabled = tab != Tab.OVERVIEW && router.backStack(tab).size == 1) {
                router.select(Tab.OVERVIEW)
            }
            Box(Modifier.fillMaxSize()) {
                key(tab) {
                    NavDisplay(
                        entries = entriesByTab.getValue(tab),
                        onBack = { router.pop(tab) },
                    )
                }
                SnackbarHost(
                    hostState = snackbarHostState,
                    modifier = Modifier.align(Alignment.BottomCenter).padding(bottom = 80.dp).testTag("shell-snackbar"),
                )
            }
        }
    }
}

/** Bottom bar / rail icon (iOS SF Symbols: square.grid.2x2, terminal, books.vertical, chart.bar, ellipsis). */
private val Tab.icon: ImageVector
    get() =
        when (this) {
            Tab.OVERVIEW -> Icons.Outlined.GridView
            Tab.WORK -> Icons.Outlined.Terminal
            Tab.LIBRARY -> Icons.AutoMirrored.Outlined.LibraryBooks
            Tab.INSIGHTS -> Icons.Outlined.BarChart
            Tab.MORE -> Icons.Outlined.MoreHoriz
        }
