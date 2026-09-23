package dev.optio.feature.overview

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import dev.optio.core.navigation.WorkView
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.SkeletonStrip
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.workfeed.WorkFeedModel
import dev.optio.core.workfeed.WorkRow

/** The five tiles' labels, also the skeleton's. */
internal val BoardTileLabels = listOf("Need you", "Running", "Waiting", "Recurring", "Agents")

/**
 * The Overview's centre (iOS `SessionsBoardSections`, web `dashboard/work-board.tsx`): one board
 * over the unified Work feed. Five tiles (each a saved view of the Work list), then what's alive
 * right now, then the recurring work and persistent agents that will wake on their own. Emits
 * `LazyColumn` items, so it sits inside the Overview's grouped list.
 */
internal fun LazyListScope.workBoard(
    feed: WorkFeedModel.State,
    onOpenView: (WorkView) -> Unit,
    onOpenRow: (WorkRow) -> Unit,
    onOpenPr: (String) -> Unit,
    onNewWork: () -> Unit,
    onRetry: () -> Unit,
) {
    val counts = feed.counts
    val active = feed.rows(WorkView.ACTIVE).take(8)
    val recurring = feed.rows(WorkView.RECURRING).take(5)
    val agents = feed.rows(WorkView.AGENTS).take(5)

    item(key = "board-tiles", contentType = "tiles") {
        Box(Modifier.padding(horizontal = Spacing.l).padding(top = Spacing.l)) {
            if (feed.placeholder) {
                SkeletonStrip(labels = BoardTileLabels)
            } else {
                StatStrip(
                    items = listOf(
                        StatItem("Need you", counts.needsYou, tone = Tone.ACCENT, key = "active"),
                        StatItem("Running", counts.running, key = "running"),
                        StatItem("Waiting", counts.waiting, key = "waiting"),
                        StatItem("Recurring", counts.recurring, key = "recurring"),
                        StatItem("Agents", counts.agents, key = "agents"),
                    ),
                    onSelect = { item ->
                        onOpenView(
                            when (item.key) {
                                "recurring" -> WorkView.RECURRING
                                "agents" -> WorkView.AGENTS
                                else -> WorkView.ACTIVE
                            },
                        )
                    },
                )
            }
        }
    }
    feed.error?.let { error ->
        item(key = "board-error", contentType = "error") {
            ErrorRow(error = error, what = "work", retry = onRetry, modifier = Modifier.padding(horizontal = Spacing.l))
        }
    }

    // "Active now · N          All ›  + New work" (work-board.tsx header).
    sectionHeader(
        key = "board-active-header",
        title = "Active now",
        detail = if (active.isEmpty()) null else "${feed.count(WorkView.ACTIVE)}",
        action = { onOpenView(WorkView.ACTIVE) },
        trailing = { NewWorkLink(onNewWork) },
    )
    if (active.isEmpty()) {
        plainNote("board-active-empty", if (feed.placeholder) "Loading…" else "Nothing running or waiting on you right now.", centered = true)
    } else {
        groupedRows("board-active", active, key = { it.key }, dividerInset = WorkRowTextInset) { row ->
            WorkRowView(row, onClick = { onOpenRow(row) }, onOpenPr = onOpenPr)
        }
    }

    // Recurring and persistent agents sit side by side on the web; stacked here.
    miniList("board-recurring", "Recurring", recurring, feed.count(WorkView.RECURRING), "No schedules or event triggers yet.", { onOpenView(WorkView.RECURRING) }, onOpenRow, onOpenPr)
    miniList("board-agents", "Persistent agents", agents, feed.count(WorkView.AGENTS), "No persistent agents yet.", { onOpenView(WorkView.AGENTS) }, onOpenRow, onOpenPr)
}

private fun LazyListScope.miniList(
    key: String,
    title: String,
    rows: List<WorkRow>,
    total: Int,
    empty: String,
    onOpenView: () -> Unit,
    onOpenRow: (WorkRow) -> Unit,
    onOpenPr: (String) -> Unit,
) {
    sectionHeader(key = "$key-header", title = title, detail = "$total", action = onOpenView)
    if (rows.isEmpty()) {
        plainNote("$key-empty", empty)
    } else {
        groupedRows(key, rows, key = { it.key }, dividerInset = WorkRowTextInset) { row ->
            WorkRowView(row, onClick = { onOpenRow(row) }, onOpenPr = onOpenPr)
        }
    }
}

/** "+ New work" beside the Active now header (footnote semibold, accent). */
@Composable
private fun NewWorkLink(onClick: () -> Unit) {
    Row(
        Modifier
            .clip(Radius.smallShape)
            .clickable(role = Role.Button, onClick = onClick)
            .padding(horizontal = Spacing.xs, vertical = 2.dp)
            .testTag("board-new-work"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Icon(Icons.Filled.Add, contentDescription = null, tint = OptioTheme.colors.accent, modifier = Modifier.size(16.dp))
        Text("New work", style = OptioTheme.type.footnote.semibold(), color = OptioTheme.colors.accent, maxLines = 1)
    }
}
