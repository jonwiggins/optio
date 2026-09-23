package dev.optio.feature.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone

// The Overview is an inset-grouped list (iOS `.listStyle(.insetGrouped)`): section headers over
// cards of rows, on the grouped page. These build it out of `LazyColumn` items.

/** Where a WorkRowView's title starts (gutter + dot + gap): its separators start there too. */
internal val WorkRowTextInset: Dp = Spacing.l + 7.dp + Spacing.s

/** One item of a card that spans several items: gutter, card colour, corners only at its ends. */
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
 * A section header aligned with the text inside the cards below it (iOS `SectionHeader` in an
 * inset-grouped list). [trailing] sits after the header (the board's "New work").
 */
internal fun LazyListScope.sectionHeader(
    key: String,
    title: String,
    detail: String? = null,
    tone: Tone? = null,
    action: (() -> Unit)? = null,
    trailing: (@Composable () -> Unit)? = null,
) {
    item(key = key, contentType = "header") {
        Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.l), verticalAlignment = Alignment.CenterVertically) {
            SectionHeader(title = title, detail = detail, tone = tone, action = action, modifier = Modifier.weight(1f))
            if (trailing != null) Box(Modifier.padding(top = Spacing.l + Spacing.xs, bottom = Spacing.s)) { trailing() }
        }
    }
}

/** [rows] on one card, separated by hairlines inset to [dividerInset]. */
internal fun <T> LazyListScope.groupedRows(
    keyPrefix: String,
    rows: List<T>,
    key: (T) -> String,
    dividerInset: Dp = Spacing.l,
    content: @Composable BoxScope.(T) -> Unit,
) {
    itemsIndexed(rows, key = { _, row -> "$keyPrefix-${key(row)}" }, contentType = { _, _ -> keyPrefix }) { index, row ->
        GroupedRow(index, rows.size, dividerInset) { content(row) }
    }
}

@Composable
private fun LazyItemScope.GroupedRow(
    index: Int,
    count: Int,
    dividerInset: Dp,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(Modifier.animateItem().groupedItem(index, count)) {
        content()
        if (index < count - 1) InsetDivider(Modifier.align(Alignment.BottomStart), start = dividerInset)
    }
}

/** A single card-less line under a header (iOS rows with `.listRowBackground(Color.clear)`). */
internal fun LazyListScope.plainNote(
    key: String,
    text: String,
    centered: Boolean = false,
) {
    item(key = key, contentType = "note") {
        Box(
            Modifier.fillMaxWidth().padding(PaddingValues(horizontal = Spacing.l + Spacing.l, vertical = if (centered) Spacing.m else Spacing.xs)),
            contentAlignment = if (centered) Alignment.Center else Alignment.CenterStart,
        ) {
            Text(text, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
        }
    }
}
