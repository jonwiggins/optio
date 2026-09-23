package dev.optio.core.ui.state

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.SkeletonRows
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.launch

/**
 * The async-loading wrapper (iOS `Loadable`): [content] once there is a value (also while it
 * refreshes or after a failed refresh), otherwise an [ErrorRow] with Retry for a failure, otherwise
 * [placeholder] (skeleton rows; never a bare spinner). With [onRefresh] the whole thing
 * pulls to refresh; the spinner shows while [LoadState.isRefreshing].
 *
 * [content] should scroll (a `LazyColumn` with `contentPadding`) so pull-to-refresh can reach it.
 */
@Composable
fun <T> Loadable(
    state: LoadState<T>,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    what: String? = null,
    onRefresh: (() -> Unit)? = onRetry,
    contentPadding: PaddingValues = PaddingValues(),
    placeholder: @Composable () -> Unit = { SkeletonRows() },
    content: @Composable (T) -> Unit,
) {
    val value = state.value
    val body: @Composable BoxScope.() -> Unit = {
        when {
            value != null -> content(value)
            state is LoadState.Failed -> LazyColumn(Modifier.fillMaxSize().testTag("loadable-error"), contentPadding = contentPadding) {
                item { ErrorRow(error = state.error, what = what, retry = onRetry) }
            }
            else -> LazyColumn(Modifier.fillMaxSize().testTag("loadable-loading"), contentPadding = contentPadding, userScrollEnabled = false) {
                item { placeholder() }
            }
        }
    }
    if (onRefresh != null) {
        PullToRefreshBox(isRefreshing = state.isRefreshing, onRefresh = onRefresh, modifier = modifier.fillMaxSize(), content = body)
    } else {
        Box(modifier.fillMaxSize(), content = body)
    }
}

/**
 * [Loadable] that runs [load] itself (iOS `Loadable(load:)`): on first composition, again when
 * [key] changes, on Retry and on pull-to-refresh. For screens without a ViewModel.
 */
@Composable
fun <T> Loadable(
    load: suspend () -> T,
    modifier: Modifier = Modifier,
    key: Any? = Unit,
    what: String? = null,
    contentPadding: PaddingValues = PaddingValues(),
    placeholder: @Composable () -> Unit = { SkeletonRows() },
    content: @Composable (T) -> Unit,
) {
    val controller = rememberLoadController(key, load = load)
    Loadable(
        state = controller.state,
        onRetry = controller::reload,
        modifier = modifier,
        what = what,
        contentPadding = contentPadding,
        placeholder = placeholder,
        content = content,
    )
}

/** Holds a [LoadState] for a composable-scoped loader ([rememberLoadController]). */
@Stable
class LoadController<T> internal constructor(
    private val scope: CoroutineScope,
    private val loader: () -> (suspend () -> T),
) {
    var state: LoadState<T> by mutableStateOf(LoadState.Idle)
        private set

    private var job: Job? = null

    /** Starts a load (cancelling one in flight); the value on screen stays while it runs. */
    fun reload() {
        job?.cancel()
        job = scope.launch { run() }
    }

    /** A load the caller awaits (the first load, a pull-to-refresh). */
    suspend fun refresh() {
        job?.cancel()
        run()
    }

    private suspend fun run() {
        state = state.loading()
        state = try {
            LoadState.Loaded(loader()())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            state.failed(e)
        }
    }
}

/** A [LoadController] that loads on first composition and whenever one of [keys] changes. */
@Composable
fun <T> rememberLoadController(vararg keys: Any?, load: suspend () -> T): LoadController<T> {
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(load)
    val controller = remember(*keys) { LoadController(scope) { latest } }
    LaunchedEffect(controller) { controller.refresh() }
    return controller
}
