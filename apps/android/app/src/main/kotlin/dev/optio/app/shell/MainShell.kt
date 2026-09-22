package dev.optio.app.shell

import androidx.activity.compose.BackHandler
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.LibraryBooks
import androidx.compose.material.icons.outlined.BarChart
import androidx.compose.material.icons.outlined.GridView
import androidx.compose.material.icons.outlined.MoreHoriz
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.adaptive.navigationsuite.NavigationSuiteScaffold
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.key
import androidx.compose.runtime.remember
import androidx.compose.ui.ExperimentalComposeUiApi
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.testTagsAsResourceId
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

/**
 * The signed-in shell (PLAN §4): a `NavigationSuiteScaffold` (bottom bar on phones, rail on wide
 * screens) with Overview · Work · Library · Insights · More, and one Navigation 3 back stack per
 * tab. Re-selecting the tab on screen pops it to its hub; Back at a hub other than Overview
 * returns to Overview.
 *
 * Every tab's entries stay decorated (saveable state + entry-scoped ViewModels) while another
 * tab is on screen, so switching tabs keeps each stack exactly as it was (like iOS). The whole
 * shell, and all of that state, is dropped when C keys it on `session.generation`.
 */
@OptIn(ExperimentalComposeUiApi::class)
@Composable
fun MainShell(
    modifier: Modifier = Modifier,
    router: AppRouter = rememberAppRouter(),
) {
    val context = LocalContext.current
    val navigator = remember(router, context) { RouterNavigator(router) { url -> context.openExternalUrl(url) } }
    val entryProvider = remember { appEntryProvider() }

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
            key(tab) {
                NavDisplay(
                    entries = entriesByTab.getValue(tab),
                    onBack = { router.pop(tab) },
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
