package dev.optio.core.workfeed.ui

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.filled.PushPin
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.Brand
import dev.optio.core.ui.components.BrandMark
import dev.optio.core.ui.components.RuntimeMark
import dev.optio.core.ui.components.SessionLinkBadges
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.scope.PrivateTag
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.theme.tabularNums
import dev.optio.core.workfeed.WhenKind
import dev.optio.core.workfeed.WorkRow
import dev.optio.core.workfeed.WorkStatus
import dev.optio.core.workfeed.WorkThen
import dev.optio.core.workfeed.WorkWhere

// One piece of work as a card (iOS `WorkRowView`, v0.15; the web session rail): the runtime's
// mark with its status dot, the name and its place, the location and recency, the status, a note,
// the trigger and exit condition for work that has them, the ticket / PR badges, and the Private
// tag. The Work list, the Overview's Needs-you and board, and the Machines page all draw this one
// card, so it lives in `:core:workfeed` (features never depend on each other).

/** The dot colour of a status (iOS `WorkStatus.tone`). */
val WorkStatus.tone: Tone
    get() = when (this) {
        WorkStatus.NEEDS_YOU -> Tone.ACCENT
        WorkStatus.RUNNING -> Tone.WORKING
        WorkStatus.WAITING -> Tone.SUCCESS
        WorkStatus.FAILED -> Tone.WARNING
        WorkStatus.QUEUED, WorkStatus.SCHEDULED, WorkStatus.PAUSED, WorkStatus.DONE -> Tone.IDLE
    }

/** The size of the runtime mark at the card's leading edge. */
val WorkRowMarkSize: Dp = 36.dp

/** Where a card's text starts: the gutter, the mark and the gap after it (divider inset). */
val WorkRowTextInset: Dp = Spacing.l + WorkRowMarkSize + Spacing.m

/**
 * One card. Tapping opens the detail ([onClick]); a badge opens its link ([onOpenLink], the
 * system browser when null). [whereLabel] replaces the place line where the place is already said
 * around the card (the Machines page names the host, so its cards name only the directory).
 * Test tags: `work-row-<key>`, `work-row-pin-<key>`, `work-row-pr` on the task's own PR badge.
 */
@Composable
fun WorkRowCard(
    row: WorkRow,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    onOpenLink: ((String) -> Unit)? = null,
    whereLabel: String? = null,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val now = rememberNow()
    val name = row.name.ifEmpty { "Untitled" }
    Column(
        modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClickLabel = "Open", onClick = onClick)
            .padding(horizontal = Spacing.l, vertical = Spacing.m)
            .testTag("work-row-${row.key}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
            RuntimeMark(
                runtime = if (row.isTerminal) "terminal" else row.who,
                tone = row.status.tone,
                size = WorkRowMarkSize,
                modifier = Modifier.padding(top = 2.dp),
            )
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    Text(
                        name,
                        style = type.subheadline.semibold(),
                        color = colors.label,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f),
                    )
                    // A pinned session wears a filled pin: it sits at the top until unpinned.
                    if (row.pinned) {
                        Icon(
                            Icons.Filled.PushPin,
                            contentDescription = "Pinned",
                            tint = colors.secondaryLabel,
                            modifier = Modifier.padding(top = 2.dp).size(12.dp).testTag("work-row-pin-${row.key}"),
                        )
                    }
                }
                Text(
                    placeLabel(row, whereLabel),
                    style = type.caption.mono(),
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.MiddleEllipsis,
                )
            }
        }

        // Where it runs (the host, or "Optio pod" / "Machine") and when it last moved.
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Row(Modifier.weight(1f), verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Icon(row.where.icon, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(12.dp))
                Text(
                    row.where.hostName ?: if (row.where.target == WorkWhere.Target.POD) "Optio pod" else "Machine",
                    style = type.caption,
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            row.lastActivity?.let { last ->
                Text(
                    last.relativeDescription(now),
                    style = type.caption.tabularNums(),
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                )
            }
        }

        val loud = row.status == WorkStatus.NEEDS_YOU || row.status == WorkStatus.FAILED || row.status == WorkStatus.RUNNING
        Text(
            row.statusLabel,
            style = type.caption.medium(),
            color = if (loud) row.status.tone.textColor else colors.secondaryLabel,
        )

        // The PR number is a badge below; any other note (the attention reason, "opens a PR each run") reads here.
        val note = row.note?.takeIf { it.isNotEmpty() && !it.startsWith("PR ") }
        if (note != null) {
            Text(
                note,
                style = type.caption,
                color = if (row.status == WorkStatus.NEEDS_YOU || row.status == WorkStatus.FAILED) row.status.tone.textColor else colors.tertiaryLabel,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }

        // Interactive sessions need no repeated "now / waits for me" line; definitions and PR
        // work keep their trigger and exit condition.
        if (row.recurring || row.then == WorkThen.UNTIL_MERGED || row.then == WorkThen.WAITS_FOR_MESSAGES || row.whenLabel != "now") {
            Attributes(row)
        }

        SessionLinkBadges(
            links = row.links,
            primaryPr = row.prUrl,
            prState = row.prState,
            onOpen = onOpenLink,
        )

        // Private work wears its tag ("Private", or "Private · Name" to an admin); the organization's carries none.
        if (row.isPrivate) PrivateTag(row.ownerUserId, row.ownerName)
    }
}

/** The second line under the name: the directory's last two segments on a machine, else the place. */
private fun placeLabel(row: WorkRow, whereLabel: String?): String {
    if (whereLabel != null) return whereLabel
    val dir = row.where.dir
    if (!dir.isNullOrEmpty()) return dir.split('/').filter { it.isNotEmpty() }.takeLast(2).joinToString("/")
    return row.where.label
}

/** When (the trigger, with its source's mark) · Then (the exit condition). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun Attributes(row: WorkRow) {
    FlowRow(
        Modifier.fillMaxWidth(),
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        val origin = Brand.fromProvider(row.origin)
        Attribute(row.whenLabel) {
            if (origin != null) {
                // Brand marks read at secondary weight; quaternary washes them out.
                BrandMark(origin, size = 13.dp, contentDescription = "from ${origin.label}", tint = OptioTheme.colors.secondaryLabel)
            } else {
                Icon(row.whenKind.icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(13.dp))
            }
        }
        Attribute(row.then.label) {
            Icon(row.then.icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(13.dp))
        }
    }
}

@Composable
private fun Attribute(
    label: String,
    icon: @Composable () -> Unit,
) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
        icon()
        Text(
            label,
            style = OptioTheme.type.caption,
            color = OptioTheme.colors.tertiaryLabel,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
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
