package dev.optio.feature.library

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.capitalizedFirst
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden

/**
 * A lazy list for a [LoadState] (the Library's lists, details and forms). With [onRefresh] it pulls
 * to refresh, the spinner showing while [state] refreshes over a value on screen (forms pass null).
 * Content is centred at a readable width on wide screens.
 */
@Composable
internal fun <T> LibraryList(
    state: LoadState<T>,
    onRefresh: (() -> Unit)?,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    listState: LazyListState = rememberLazyListState(),
    testTag: String? = null,
    content: LazyListScope.() -> Unit,
) {
    val list: @Composable () -> Unit = {
        LazyColumn(
            modifier = Modifier
                .fillMaxSize()
                .consumeWindowInsets(contentPadding)
                .imePadding()
                .readableWidth()
                .let { if (testTag != null) it.testTag(testTag) else it },
            state = listState,
            contentPadding = contentPadding,
            content = content,
        )
    }
    if (onRefresh != null) {
        PullRefresh(refreshing = state.isRefreshing, onRefresh = onRefresh, modifier = modifier) { list() }
    } else {
        Box(modifier.fillMaxSize()) { list() }
    }
}

/**
 * The state-dependent part of a list (iOS: `if loading { SkeletonRows } else if error, empty {
 * ErrorRow } else …`): [content] with the value (also while it refreshes or after a failed
 * refresh), else a 403 as [AdminOnlyState], another failure as an [ErrorRow] with Retry, else
 * skeleton rows.
 */
internal fun <T> LazyListScope.loadStateItems(
    state: LoadState<T>,
    what: String,
    onRetry: () -> Unit,
    content: LazyListScope.(T) -> Unit,
) {
    val value = state.value
    when {
        value != null -> content(value)
        state is LoadState.Failed -> item(key = "load-error", contentType = "state") {
            if (state.error.isForbidden) {
                AdminOnlyState(what = what.capitalizedFirst())
            } else {
                ErrorRow(state.error, what = what, retry = onRetry)
            }
        }
        else -> item(key = "load-skeleton", contentType = "state") { SkeletonRows() }
    }
}

/**
 * A form screen's body (repo settings, new repo, new connection, the template editor): one
 * scrolling column, so a focused field stays alive when it scrolls away (a lazy list would drop
 * it and close the keyboard), padded clear of the keyboard. Shows [content] once [state] has a
 * value, else the failure (403 → [AdminOnlyState]) or skeleton rows.
 */
@Composable
internal fun <T> LibraryForm(
    state: LoadState<T>,
    what: String,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    testTag: String? = null,
    content: @Composable ColumnScope.(T) -> Unit,
) {
    val value = state.value
    FormColumn(modifier, contentPadding, testTag) {
        when {
            value != null -> content(value)
            state is LoadState.Failed -> if (state.error.isForbidden) {
                AdminOnlyState(what = what.capitalizedFirst())
            } else {
                ErrorRow(state.error, what = what, retry = onRetry, modifier = Modifier.fillMaxWidth())
            }
            else -> SkeletonRows()
        }
    }
}

/** [LibraryForm] without a load: one scrolling column of cards, clear of the keyboard. */
@Composable
internal fun FormColumn(
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
    testTag: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier
            .fillMaxSize()
            .consumeWindowInsets(contentPadding)
            .imePadding()
            .verticalScroll(rememberScrollState())
            .padding(contentPadding)
            .let { if (testTag != null) it.testTag(testTag) else it },
    ) {
        Column(Modifier.readableWidth()) {
            content()
            Spacer(Modifier.height(24.dp))
        }
    }
}
