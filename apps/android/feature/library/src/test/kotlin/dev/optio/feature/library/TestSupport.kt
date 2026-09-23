package dev.optio.feature.library

import dev.optio.core.ui.state.LoadState
import kotlinx.coroutines.flow.first

/** Suspends until the ViewModel holds a loaded value (the first load, or a reload matching [where]). */
suspend fun <T> LibraryViewModel<T>.awaitLoaded(where: (T) -> Boolean = { true }): T =
    state.first { it is LoadState.Loaded && where(it.value) }.value!!

/** Suspends until the latest load failed and returns the error. */
suspend fun <T> LibraryViewModel<T>.awaitFailure(): Throwable =
    (state.first { it is LoadState.Failed } as LoadState.Failed).error

/** The next toast / close the ViewModel asked its screen for. */
suspend fun LibraryActionsViewModel.nextEvent(): ScreenEvent = events.first()

/** The next toast's text. */
suspend fun LibraryActionsViewModel.nextToast(): ScreenEvent.Toast =
    events.first { it is ScreenEvent.Toast } as ScreenEvent.Toast
