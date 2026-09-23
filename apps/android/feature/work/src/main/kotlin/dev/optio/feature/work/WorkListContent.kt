package dev.optio.feature.work

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.LocalSoftwareKeyboardController
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.optio.core.navigation.WorkView
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.workfeed.WorkCounts
import dev.optio.core.workfeed.WorkFeedModel
import dev.optio.core.workfeed.WorkRow

/** Room under the last row so the "New work" FAB never covers it. */
private val FabClearance: Dp = 88.dp

/**
 * The Work list's body (iOS `WorkListView.content`), stateless: the view chips with their counts,
 * the counts line, the search field when open, the error row, then the rows of the selected view
 * on one card, a skeleton on the first load, or an empty state. Pulls to refresh.
 */
@Composable
internal fun WorkListContent(
    state: WorkFeedModel.State,
    view: WorkView,
    query: String,
    searching: Boolean,
    refreshing: Boolean,
    contentPadding: PaddingValues,
    onSelectView: (WorkView) -> Unit,
    onQueryChange: (String) -> Unit,
    onClearSearch: () -> Unit,
    onRefresh: () -> Unit,
    onOpen: (WorkRow) -> Unit,
    onOpenPr: (String) -> Unit,
    onNewWork: () -> Unit,
    modifier: Modifier = Modifier,
    listState: LazyListState = rememberLazyListState(),
) {
    val visible = remember(state.rows, view, query) { state.rows(view, query) }
    val layoutDirection = LocalLayoutDirection.current
    // The pull indicator starts under the hub's bars; the list keeps the rest of the padding.
    PullRefresh(
        refreshing = refreshing,
        onRefresh = onRefresh,
        modifier = modifier.padding(top = contentPadding.calculateTopPadding()),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize().readableWidth().testTag("work-list"),
            contentPadding = PaddingValues(
                start = contentPadding.calculateStartPadding(layoutDirection),
                end = contentPadding.calculateEndPadding(layoutDirection),
                bottom = contentPadding.calculateBottomPadding() + FabClearance,
            ),
        ) {
            item(key = "views", contentType = "views") {
                ChipPicker(
                    options = WorkView.entries.map { it to "${it.label} ${state.count(it)}" },
                    selection = view,
                    onSelect = onSelectView,
                )
            }
            item(key = "counts", contentType = "counts") { CountsLine(state.counts) }
            if (searching || query.isNotEmpty()) {
                item(key = "search", contentType = "search") {
                    SearchField(query = query, onQueryChange = onQueryChange, onClear = onClearSearch, focusOnAppear = query.isEmpty())
                }
            }
            state.error?.let { error ->
                item(key = "error", contentType = "error") { ErrorRow(error = error, what = "work", retry = onRefresh) }
            }
            when {
                state.placeholder -> item(key = "skeleton", contentType = "skeleton") {
                    Box(Modifier.padding(horizontal = Spacing.l).clip(Radius.cardShape).background(OptioTheme.colors.card)) {
                        SkeletonRows(count = 5)
                    }
                }
                visible.isEmpty() -> item(key = "empty", contentType = "empty") {
                    EmptyState(
                        title = when {
                            view == WorkView.ACTIVE -> "Nothing needs you right now"
                            query.isEmpty() -> "Nothing here yet"
                            else -> "Nothing matches"
                        },
                        icon = Icons.Outlined.Terminal,
                        message = if (view == WorkView.ACTIVE) {
                            "Running, queued, and waiting work shows up here. Recurring work lives under its own view until it fires."
                        } else {
                            "Start something — a PR, a chat on your machine, a schedule, or a persistent agent."
                        },
                        actionTitle = if (query.isEmpty()) "New work" else null,
                        action = onNewWork,
                    )
                }
                else -> itemsIndexed(visible, key = { _, row -> row.key }, contentType = { _, _ -> "row" }) { index, row ->
                    Box(Modifier.animateItem().groupedItem(index, visible.size)) {
                        WorkRowView(row = row, onClick = { onOpen(row) }, onOpenPr = onOpenPr)
                        if (index < visible.lastIndex) {
                            InsetDivider(Modifier.align(Alignment.BottomStart), start = Spacing.l + 7.dp + Spacing.s)
                        }
                    }
                }
            }
        }
    }
}

/**
 * One item of a card that spans several `LazyColumn` items: the screen gutter, the card colour,
 * and rounded corners only at the card's top and bottom.
 */
@Composable
internal fun Modifier.groupedItem(
    index: Int,
    count: Int,
): Modifier {
    val r = Radius.card
    val shape = when {
        count == 1 -> RoundedCornerShape(r)
        index == 0 -> RoundedCornerShape(topStart = r, topEnd = r)
        index == count - 1 -> RoundedCornerShape(bottomStart = r, bottomEnd = r)
        else -> RoundedCornerShape(0.dp)
    }
    return this.padding(horizontal = Spacing.l).clip(shape).background(OptioTheme.colors.card)
}

/**
 * "2 need you · 3 running · 1 waiting · 4 recurring · 1 agent" (the web page header's meta), the
 * needs-you count in the accent tone. Shrinks rather than wrapping on narrow screens.
 */
@Composable
private fun CountsLine(c: WorkCounts) {
    val colors = OptioTheme.colors
    val text = buildAnnotatedString {
        if (c.needsYou > 0) {
            withStyle(SpanStyle(color = Tone.ACCENT.textColor)) { append("${c.needsYou} need${if (c.needsYou == 1) "s" else ""} you") }
            withStyle(SpanStyle(color = colors.tertiaryLabel)) { append(" · ") }
        }
        append("${c.running} running · ${c.waiting} waiting · ${c.recurring} recurring · ${c.agents} agent${if (c.agents == 1) "" else "s"}")
    }
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = colors.secondaryLabel,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        autoSize = TextAutoSize.StepBased(minFontSize = 10.sp, maxFontSize = OptioTheme.type.footnote.fontSize),
        modifier = Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.s).testTag("work-counts"),
    )
}

/**
 * The search field (iOS `.searchable(prompt:)`): a filled capsule with a clear button while it
 * holds text. The top bar's search action opens and closes it.
 */
@Composable
private fun SearchField(
    query: String,
    onQueryChange: (String) -> Unit,
    onClear: () -> Unit,
    focusOnAppear: Boolean,
) {
    val focus = remember { FocusRequester() }
    val keyboard = LocalSoftwareKeyboardController.current
    val colors = OptioTheme.colors
    TextField(
        value = query,
        onValueChange = onQueryChange,
        modifier = Modifier
            .fillMaxWidth()
            .padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.s)
            .focusRequester(focus)
            .testTag("work-search"),
        placeholder = { Text("Search name, place, agent…", maxLines = 1) },
        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
        trailingIcon = if (query.isEmpty()) {
            null
        } else {
            {
                IconButton(onClick = onClear, modifier = Modifier.testTag("work-search-clear")) {
                    Icon(Icons.Outlined.Cancel, contentDescription = "Clear search")
                }
            }
        },
        singleLine = true,
        shape = Radius.bubbleShape,
        textStyle = OptioTheme.type.body,
        colors = TextFieldDefaults.colors(
            focusedContainerColor = colors.fillTertiary,
            unfocusedContainerColor = colors.fillTertiary,
            focusedIndicatorColor = Color.Transparent,
            unfocusedIndicatorColor = Color.Transparent,
            focusedLeadingIconColor = colors.secondaryLabel,
            unfocusedLeadingIconColor = colors.secondaryLabel,
            focusedTrailingIconColor = colors.secondaryLabel,
            unfocusedTrailingIconColor = colors.secondaryLabel,
            focusedPlaceholderColor = colors.tertiaryLabel,
            unfocusedPlaceholderColor = colors.tertiaryLabel,
        ),
        keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
        keyboardActions = KeyboardActions(onSearch = { keyboard?.hide() }),
    )
    if (focusOnAppear) {
        LaunchedEffect(Unit) { runCatching { focus.requestFocus() } }
    }
}
