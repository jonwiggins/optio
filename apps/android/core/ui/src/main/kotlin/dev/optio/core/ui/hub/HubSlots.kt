package dev.optio.core.ui.hub

import androidx.compose.foundation.layout.RowScope
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * The hub slot API: how a hub section contributes chrome to the hub that hosts it.
 *
 * A hub (Overview, Work, Library, Insights, More; they live in `:app`) owns the top app bar and
 * the floating-action-button slot. The section on screen (a composable exported by a feature
 * module) declares what goes there by calling [HubActions] and/or [HubFab] anywhere in its body:
 *
 * ```
 * @Composable
 * fun ReposSection(contentPadding: PaddingValues, modifier: Modifier = Modifier) {
 *     val navigator = LocalNavigator.current
 *     HubActions {
 *         IconButton(onClick = { navigator.push(NewRepoRoute) }) {
 *             Icon(Icons.Default.Add, contentDescription = "Add repo")
 *         }
 *     }
 *     HubFab {
 *         FloatingActionButton(onClick = { … }) { Icon(Icons.Default.Add, contentDescription = null) }
 *     }
 *     LazyColumn(modifier.fillMaxSize(), contentPadding = contentPadding) { … }
 * }
 * ```
 *
 * Registrations follow the caller's lifecycle: they appear when it enters composition, pick up
 * new content when it recomposes, and are removed when it leaves (switching section, or pushing
 * a detail over the hub). The newest registration wins, so during a crossfade between two
 * sections the incoming one shows. Call each at most once per section. Outside a hub (details,
 * previews, screenshot tests) there is no [LocalHubController] and both calls do nothing.
 *
 * The hosting hub creates one controller with [rememberHubController], provides it through
 * [LocalHubController] around the section, and renders [HubController.actions] inside its
 * `TopAppBar(actions = …)` and [HubController.fab] in its `Scaffold(floatingActionButton = …)`.
 */
@Stable
class HubController {
    private val actionSlots = mutableStateListOf<@Composable RowScope.() -> Unit>()
    private val fabSlots = mutableStateListOf<@Composable () -> Unit>()

    /** Top-bar actions of the newest registered section, or null. Render inside `TopAppBar(actions)`. */
    val actions: (@Composable RowScope.() -> Unit)?
        get() = actionSlots.lastOrNull()

    /** FAB of the newest registered section, or null. Render in `Scaffold(floatingActionButton)`. */
    val fab: (@Composable () -> Unit)?
        get() = fabSlots.lastOrNull()

    internal fun addActions(slot: @Composable RowScope.() -> Unit) {
        actionSlots.add(slot)
    }

    internal fun removeActions(slot: @Composable RowScope.() -> Unit) {
        actionSlots.remove(slot)
    }

    internal fun addFab(slot: @Composable () -> Unit) {
        fabSlots.add(slot)
    }

    internal fun removeFab(slot: @Composable () -> Unit) {
        fabSlots.remove(slot)
    }
}

/** The [HubController] of the hub hosting the current section; null outside a hub. */
val LocalHubController = staticCompositionLocalOf<HubController?> { null }

/** One [HubController] per hub screen. */
@Composable
fun rememberHubController(): HubController = remember { HubController() }

/** Contributes [content] (usually `IconButton`s) to the hosting hub's top app bar actions. */
@Composable
fun HubActions(content: @Composable RowScope.() -> Unit) {
    val controller = LocalHubController.current ?: return
    val latest = rememberUpdatedState(content)
    DisposableEffect(controller) {
        val slot: @Composable RowScope.() -> Unit = { latest.value(this) }
        controller.addActions(slot)
        onDispose { controller.removeActions(slot) }
    }
}

/** Contributes [content] (usually a `FloatingActionButton`) as the hosting hub's FAB. */
@Composable
fun HubFab(content: @Composable () -> Unit) {
    val controller = LocalHubController.current ?: return
    val latest = rememberUpdatedState(content)
    DisposableEffect(controller) {
        val slot: @Composable () -> Unit = { latest.value() }
        controller.addFab(slot)
        onDispose { controller.removeFab(slot) }
    }
}
