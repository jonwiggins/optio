package dev.optio.feature.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Merge
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.AgentMark
import dev.optio.core.ui.components.Brand
import dev.optio.core.ui.components.BrandMark
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PrGlyph
import dev.optio.core.ui.components.PrGlyphState
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.scope.PrivateTag
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.tabularNums
import dev.optio.core.workfeed.WhenKind
import dev.optio.core.workfeed.WorkRow
import dev.optio.core.workfeed.WorkStatus
import dev.optio.core.workfeed.WorkThen
import dev.optio.core.workfeed.WorkWhere

// One piece of work as a row (iOS `WorkRowView`, web `work-row.tsx`), for the Overview board. A copy
// of `:feature:work`'s `WorkRowView.kt` (features never depend on each other): keep the two in step.

/** The dot colour of a status (iOS `WorkStatus.tone`). */
internal val WorkStatus.tone: Tone
    get() = when (this) {
        WorkStatus.NEEDS_YOU -> Tone.ACCENT
        WorkStatus.RUNNING -> Tone.WORKING
        WorkStatus.WAITING -> Tone.SUCCESS
        WorkStatus.FAILED -> Tone.DANGER
        WorkStatus.QUEUED, WorkStatus.SCHEDULED, WorkStatus.PAUSED, WorkStatus.DONE -> Tone.IDLE
    }

/** Where the title starts: the row gutter, the 7dp dot and the gap after it. */
private val TextInset = Spacing.l + 7.dp + Spacing.s

/**
 * One row: a status dot, the name with its recency, `statusLabel · note` with a PR link, and the
 * four attribute chips (When · Where / Who · Then) in two columns. Tapping opens the detail; the
 * PR chip opens the pull request. Test tags: `work-row-<key>`, `work-row-pr`.
 */
@Composable
internal fun WorkRowView(
    row: WorkRow,
    onClick: () -> Unit,
    onOpenPr: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val now = rememberNow()
    Column(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = "Open", onClick = onClick)
            .testTag("work-row-${row.key}"),
    ) {
        OptioRow(
            title = row.name.ifEmpty { "Untitled" },
            titleMaxLines = 2,
            leading = { StateDot(row.status.tone) },
            meta = statusLine(row),
            trailingContent = {
                Column(horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    // Private work wears its tag ("Private", or "Private · Name" to an admin); the organization's carries none.
                    if (row.isPrivate) PrivateTag(row.ownerUserId, row.ownerName, modifier = Modifier.padding(top = 3.dp))
                    row.lastActivity?.let { last ->
                        Text(
                            last.relativeDescription(now),
                            style = OptioTheme.type.footnote.tabularNums(),
                            color = OptioTheme.colors.tertiaryLabel,
                            maxLines = 1,
                            modifier = Modifier.padding(top = if (row.isPrivate) 0.dp else 3.dp),
                        )
                    }
                    row.prUrl?.let { PrChip(PrGlyphState.from(row.prState)) { onOpenPr(it) } }
                }
            },
            contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, top = Spacing.m),
        )
        AttributeGrid(row, Modifier.padding(start = TextInset, end = Spacing.l, top = Spacing.xs, bottom = Spacing.m))
    }
}

/** `statusLabel · note`: the status in its tone when it needs you or failed, the note tertiary. */
@Composable
private fun statusLine(row: WorkRow): AnnotatedString {
    val colors = OptioTheme.colors
    val statusColor = if (row.status == WorkStatus.NEEDS_YOU || row.status == WorkStatus.FAILED) row.status.tone.textColor else colors.secondaryLabel
    return buildAnnotatedString {
        withStyle(SpanStyle(color = statusColor)) { append(row.statusLabel) }
        row.note?.let { note ->
            withStyle(SpanStyle(color = colors.tertiaryLabel)) { append(" · $note") }
        }
    }
}

/** The "PR" link capsule: GitHub's pull-request glyph in its state's colour + "PR" on a tertiary fill. */
@Composable
private fun PrChip(state: PrGlyphState, onClick: () -> Unit) {
    Row(
        Modifier
            .clip(Radius.smallShape)
            .background(OptioTheme.colors.fillTertiary)
            .clickable(role = Role.Button, onClickLabel = "Open pull request", onClick = onClick)
            .padding(horizontal = 6.dp, vertical = 2.dp)
            .testTag("work-row-pr"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        PrGlyph(state, size = 12.dp)
        Text("PR", style = OptioTheme.type.caption2.medium(), color = OptioTheme.colors.secondaryLabel, maxLines = 1)
    }
}

/** When · Where on the first line, Who · Then on the second, each half the width. */
@Composable
private fun AttributeGrid(
    row: WorkRow,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            val origin = Brand.fromProvider(row.origin)
            if (origin != null) {
                Attribute(row.whenLabel, Modifier.weight(1f)) {
                    // Brand marks read at secondary weight; quaternary washes them out.
                    BrandMark(origin, size = 12.dp, contentDescription = "from ${origin.label}", tint = OptioTheme.colors.secondaryLabel)
                }
            } else {
                Attribute(row.whenKind.icon, row.whenLabel, Modifier.weight(1f))
            }
            Attribute(row.where.icon, row.where.label, Modifier.weight(1f), mono = true)
        }
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Attribute(row.whoLabel, Modifier.weight(1f)) {
                // The runtime's logo (a terminal glyph for a plain shell), at secondary weight like the brand marks.
                AgentMark(if (row.isTerminal) "terminal" else row.who, size = 12.dp, contentDescription = null, tint = OptioTheme.colors.secondaryLabel)
            }
            Attribute(row.then.icon, row.then.label, Modifier.weight(1f))
        }
    }
}

@Composable
private fun Attribute(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
) {
    Attribute(label, modifier, mono) {
        Icon(icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(12.dp))
    }
}

@Composable
private fun Attribute(
    label: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    icon: @Composable () -> Unit,
) {
    Row(modifier, verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        icon()
        Text(
            label,
            style = if (mono) OptioTheme.type.monoCaption else OptioTheme.type.caption,
            color = OptioTheme.colors.secondaryLabel,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
        )
    }
}

private val WhenKind.icon: ImageVector
    get() = when (this) {
        WhenKind.NOW -> Icons.Outlined.PlayArrow
        WhenKind.MESSAGES -> Icons.Outlined.Memory
        WhenKind.TRIGGER -> Icons.Outlined.Schedule
    }

private val WorkWhere.icon: ImageVector
    get() = if (target == WorkWhere.Target.MACHINE) Icons.Outlined.Laptop else Icons.Outlined.Dns

private val WorkThen.icon: ImageVector
    get() = when (this) {
        WorkThen.EXITS -> Icons.AutoMirrored.Outlined.Logout
        WorkThen.UNTIL_MERGED -> Icons.Outlined.Merge
        WorkThen.WAITS_FOR_ME -> Icons.Outlined.Terminal
        WorkThen.WAITS_FOR_MESSAGES -> Icons.Outlined.Memory
    }
