package dev.optio.feature.library

import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.rememberUpdatedState
import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch

/** One-shot effects a Library ViewModel asks its screen for. */
sealed interface ScreenEvent {
    /** A transient confirmation or failure (the app's toaster). */
    data class Toast(val message: String, val tone: Tone) : ScreenEvent

    /** Leave the screen (after a save or a delete). */
    data object Close : ScreenEvent
}

/**
 * The action half of a Library ViewModel: [events] for toasts and closing, and [action] to run a
 * mutation whose failure becomes a danger toast. Forms without a load (new repo) use it directly.
 */
abstract class LibraryActionsViewModel : ViewModel() {
    private val _events = Channel<ScreenEvent>(Channel.BUFFERED)
    val events: Flow<ScreenEvent> = _events.receiveAsFlow()

    protected fun toast(message: String, tone: Tone = Tone.SUCCESS) {
        _events.trySend(ScreenEvent.Toast(message, tone))
    }

    /** A failed action as a danger toast (iOS `moreErrorAlert`). */
    protected fun fail(error: Throwable) = toast(error.actionMessage(), Tone.DANGER)

    protected fun close() {
        _events.trySend(ScreenEvent.Close)
    }

    /** Runs [block] in the ViewModel's scope; a failure becomes a toast. */
    protected fun action(block: suspend () -> Unit): Job = viewModelScope.launch {
        try {
            block()
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            fail(e)
        }
    }
}

/**
 * A Library screen's ViewModel: one [LoadState] (PLAN §11) plus the [LibraryActionsViewModel]
 * events.
 *
 * iOS screens reload in `.task`, which runs every time the view appears (also when a pushed screen
 * pops back); [onAppear] does the same: the first call loads with a skeleton, later calls reload
 * quietly so an edit made on a pushed screen shows without a spinner. [refresh] is Retry and
 * pull-to-refresh.
 */
abstract class LibraryViewModel<T> : LibraryActionsViewModel() {
    private val _state = MutableStateFlow<LoadState<T>>(LoadState.Idle)
    val state: StateFlow<LoadState<T>> = _state.asStateFlow()

    private var loadJob: Job? = null

    /** The data behind the screen. */
    protected abstract suspend fun fetch(): T

    /** Retry, pull-to-refresh: a visible load over whatever is on screen. */
    fun refresh(): Job {
        loadJob?.cancel()
        return viewModelScope.launch { _state.load { fetch() } }.also { loadJob = it }
    }

    /** The screen became visible: load the first time, afterwards reload without a spinner. */
    fun onAppear() {
        if (_state.value is LoadState.Idle) {
            refresh()
        } else if (loadJob?.isActive != true) {
            loadJob = viewModelScope.launch { reloadQuietly() }
        }
    }

    /** Loads only the first time (forms: a re-appearance must not reset what the user typed). */
    fun loadOnce() {
        if (_state.value is LoadState.Idle) refresh()
    }

    /** Suspends until a quiet reload finished (after an action changed the data). */
    protected suspend fun reloadQuietly() {
        try {
            _state.value = LoadState.Loaded(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            // Keep what is on screen (iOS keeps the old rows when a refresh fails).
            if (_state.value.value == null) _state.value = LoadState.Failed(e)
        }
    }

    /** Replaces the loaded value in place (an optimistic update, or an action returned fresh data). */
    protected fun replaceValue(value: T) {
        _state.value = LoadState.Loaded(value)
    }

    /** Puts [state] on screen without loading (screenshot and UI tests). */
    internal fun seed(state: LoadState<T>) {
        _state.value = state
    }
}

/** [block]'s list, or empty when it fails (iOS `(try? await …) ?? []`); cancellation still propagates. */
internal suspend fun <T> listOrEmpty(block: suspend () -> List<T>): List<T> = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    emptyList()
}

/** [block]'s result, or null when it fails (iOS `try?`); cancellation still propagates. */
internal suspend fun <T> orNull(block: suspend () -> T): T? = try {
    block()
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    null
}

/** A Library ViewModel for the active server, scoped to the calling nav entry (or the hub). */
@Composable
internal inline fun <reified VM : ViewModel> libraryViewModel(crossinline create: (ApiClient) -> VM): VM {
    val api = LocalApiClient.current
    return viewModel { create(api) }
}

/**
 * Wires a Library ViewModel to its screen: calls `onAppear` whenever the screen (re)enters
 * composition and routes [events] to the app's toaster and the navigator.
 */
@Composable
internal fun ScreenEffects(
    events: Flow<ScreenEvent>,
    onAppear: () -> Unit,
    onClose: (() -> Unit)? = null,
) {
    val toaster = LocalToaster.current
    val navigator = LocalNavigator.current
    val close by rememberUpdatedState(onClose ?: { navigator.pop() })
    val appear by rememberUpdatedState(onAppear)
    LaunchedEffect(Unit) { appear() }
    LaunchedEffect(events) {
        events.collect { event ->
            when (event) {
                is ScreenEvent.Toast -> toaster.toast(event.message, event.tone)
                ScreenEvent.Close -> close()
            }
        }
    }
}
