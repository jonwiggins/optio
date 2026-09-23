package dev.optio.core.ui.components

import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import kotlinx.coroutines.launch

/**
 * Pull-to-refresh around scrolling [content] (iOS `.refreshable`), driven by the caller's
 * [refreshing] flag (a ViewModel's `LoadState.isRefreshing`). Fills the available space.
 */
@Composable
fun PullRefresh(
    refreshing: Boolean,
    onRefresh: () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = modifier.fillMaxSize(), content = content)
}

/**
 * Pull-to-refresh that runs a suspend [onRefresh] and shows the spinner until it returns, like
 * iOS `.refreshable { await model.refresh() }`.
 */
@Composable
fun PullRefresh(
    onRefresh: suspend () -> Unit,
    modifier: Modifier = Modifier,
    content: @Composable BoxScope.() -> Unit,
) {
    val scope = rememberCoroutineScope()
    val latest by rememberUpdatedState(onRefresh)
    var refreshing by remember { mutableStateOf(false) }
    PullRefresh(
        refreshing = refreshing,
        onRefresh = {
            if (!refreshing) {
                refreshing = true
                scope.launch {
                    try {
                        latest()
                    } finally {
                        refreshing = false
                    }
                }
            }
        },
        modifier = modifier,
        content = content,
    )
}
