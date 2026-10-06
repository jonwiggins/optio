package dev.optio.feature.work

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.ViewModelStore
import androidx.lifecycle.ViewModelStoreOwner
import androidx.lifecycle.viewmodel.CreationExtras
import androidx.lifecycle.viewmodel.compose.LocalViewModelStoreOwner
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.LocalAppRouter
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.ui.hub.LocalHubController
import dev.optio.core.ui.hub.rememberHubController
import kotlin.reflect.KClass

/**
 * The Work hub's chrome as `:app`'s `HubScreen` draws it (top app bar with the section's actions,
 * the segmented switcher, the section's FAB), for screenshots and UI tests of the real section.
 */
@Composable
internal fun TestWorkHub(
    router: AppRouter = AppRouter(),
    navigator: Navigator = Navigator.None,
    content: @Composable (PaddingValues) -> Unit,
) {
    val controller = rememberHubController()
    CompositionLocalProvider(LocalAppRouter provides router, LocalNavigator provides navigator) {
        Scaffold(
            topBar = {
                Column {
                    TopAppBar(title = { Text("Work", style = androidx.compose.material3.MaterialTheme.typography.headlineMedium) }, actions = { controller.actions?.invoke(this) })
                    dev.optio.core.ui.components.SectionTabs(
                        options = listOf("all" to "All", "reviews" to "Reviews", "inbox" to "Inbox"),
                        selection = "all",
                        onSelect = {},
                    )
                }
            },
            floatingActionButton = { controller.fab?.invoke() },
        ) { padding ->
            CompositionLocalProvider(LocalHubController provides controller) { content(padding) }
        }
    }
}

/** A ViewModel store that already holds [vm], so the section's `viewModel { … }` picks it up. */
internal fun <T : ViewModel> preloadedOwner(
    type: KClass<T>,
    vm: T,
): ViewModelStoreOwner {
    val owner = object : ViewModelStoreOwner {
        override val viewModelStore = ViewModelStore()
    }
    val factory = object : ViewModelProvider.Factory {
        @Suppress("UNCHECKED_CAST")
        override fun <V : ViewModel> create(modelClass: KClass<V>, extras: CreationExtras): V = vm as V
    }
    ViewModelProvider.create(owner, factory)[type]
    return owner
}

/** Provides [owner] as the `LocalViewModelStoreOwner`. */
@Composable
internal fun WithViewModels(
    owner: ViewModelStoreOwner,
    content: @Composable () -> Unit,
) {
    CompositionLocalProvider(LocalViewModelStoreOwner provides owner, content = content)
}
