package dev.optio.core.ui.state

import androidx.compose.runtime.Immutable
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.update

/**
 * What a screen shows while its data loads (the ViewModel contract, PLAN §3:
 * `StateFlow<LoadState<T>>`). The last good value survives a refresh and a failed refresh:
 * [Loading.previous] and [Failed.previous] carry it, and [value] reads whichever applies.
 *
 * ```
 * private val _state = MutableStateFlow<LoadState<List<Job>>>(LoadState.Idle)
 * val state = _state.asStateFlow()
 * fun refresh() = viewModelScope.launch { _state.load { api.listJobs() } }
 * ```
 */
@Immutable
sealed interface LoadState<out T> {
    /** The value to show: loaded, or kept from before the current load / failure. */
    val value: T?

    /** Nothing requested yet. */
    data object Idle : LoadState<Nothing> {
        override val value: Nothing? get() = null
    }

    /** A load is in flight; [previous] is the last good value (null on the first load). */
    data class Loading<out T>(val previous: T? = null) : LoadState<T> {
        override val value: T? get() = previous
    }

    /** The latest load succeeded. */
    data class Loaded<out T>(override val value: T) : LoadState<T>

    /** The latest load failed; [previous] is the last good value, if any. */
    data class Failed<out T>(val error: Throwable, val previous: T? = null) : LoadState<T> {
        override val value: T? get() = previous
    }

    /** True while a load runs (first load or refresh). */
    val isLoading: Boolean
        get() = this is Loading

    /** True while a load runs over a value already on screen (pull-to-refresh spinner). */
    val isRefreshing: Boolean
        get() = this is Loading && previous != null

    /** The failure of the latest load, or null. */
    val errorOrNull: Throwable?
        get() = (this as? Failed)?.error
}

/** This state moving into a load, keeping the value on screen. */
fun <T> LoadState<T>.loading(): LoadState<T> = LoadState.Loading(value)

/** This state after a failed load, keeping the value on screen. */
fun <T> LoadState<T>.failed(error: Throwable): LoadState<T> = LoadState.Failed(error, value)

/**
 * Runs [block] as a load of this flow: [LoadState.Loading] (keeping the value), then
 * [LoadState.Loaded] or [LoadState.Failed] (keeping the value). Cancellation propagates and
 * restores the state from before. Returns the loaded value, or null when it failed.
 */
suspend fun <T> MutableStateFlow<LoadState<T>>.load(block: suspend () -> T): T? {
    val before = value
    update { it.loading() }
    return try {
        val result = block()
        value = LoadState.Loaded(result)
        result
    } catch (e: CancellationException) {
        value = before
        throw e
    } catch (e: Exception) {
        update { it.failed(e) }
        null
    }
}
