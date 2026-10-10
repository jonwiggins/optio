package dev.optio.core.ui.components

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.model.WorkLink
import dev.optio.core.model.WorkLinkKind
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.mono

// The PR / ticket badges a piece of work wears (iOS `SessionLinkBadges`, web `work-links.tsx`):
// the same bounded, expandable list in work cards and session headers.

/** How many badges a resting card shows, and the most an expanded one shows. */
const val COLLAPSED_LINKS: Int = 2
const val EXPANDED_LINKS: Int = 8

/**
 * `owner/repo#519` → `PR #519`; `group/proj!45` → `MR !45`; ticket refs (`ENG-12`) as they are.
 * The repo is implied by where the work runs, so a badge carries only the number.
 */
fun shortLinkLabel(link: WorkLink): String {
    val label = link.label
    val i = label.indexOfLast { it == '#' || it == '!' }
    if (i < 0) return label
    val number = label.substring(i)
    return when (link.kind) {
        WorkLinkKind.PR -> (if (number.startsWith("!")) "MR " else "PR ") + number
        else -> number
    }
}

/** The links a collapsed / expanded badge list shows (iOS `visibleLinks`). */
fun visibleLinks(links: List<WorkLink>, expanded: Boolean): List<WorkLink> = links.take(if (expanded) EXPANDED_LINKS else COLLAPSED_LINKS)

/**
 * The badges of [links]: two at rest, up to eight once expanded ("Show N more links"), the
 * primary PR ([primaryPr]) drawn with its state's glyph colour. [expandedHeight] bounds the
 * expanded grid in a scroll (session headers must leave room for the conversation). A tap opens
 * the link through [onOpen] (the system browser by default). The primary PR's badge carries
 * [primaryTag] so a list test can find "the PR link" as it always has.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionLinkBadges(
    links: List<WorkLink>,
    modifier: Modifier = Modifier,
    primaryPr: String? = null,
    prState: String? = null,
    expandedHeight: Dp? = null,
    onOpen: ((String) -> Unit)? = null,
    primaryTag: String = "work-row-pr",
    expandedInitially: Boolean = false,
) {
    if (links.isEmpty()) return
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val uriHandler = LocalUriHandler.current
    val open: (String) -> Unit = onOpen ?: { url -> runCatching { uriHandler.openUri(url) } }
    var expanded by rememberSaveable(links.size) { mutableStateOf(expandedInitially) }
    val shown = visibleLinks(links, expanded)
    Column(modifier.fillMaxWidth().animateContentSize(), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        val grid: @Composable () -> Unit = {
            FlowRow(
                Modifier.fillMaxWidth().testTag("session-links"),
                horizontalArrangement = Arrangement.spacedBy(6.dp),
                verticalArrangement = Arrangement.spacedBy(6.dp),
            ) {
                shown.forEach { link ->
                    val primary = primaryPr != null && link.url == primaryPr
                    LinkBadge(
                        link = link,
                        prState = if (primary) PrGlyphState.from(prState) else null,
                        onClick = { open(link.url) },
                        modifier = Modifier.testTag(if (primary) primaryTag else "work-link"),
                    )
                }
            }
        }
        if (expanded && expandedHeight != null) {
            Column(Modifier.heightIn(max = expandedHeight).verticalScroll(rememberScrollState())) { grid() }
        } else {
            grid()
        }
        if (expanded && links.size > EXPANDED_LINKS) {
            Text("Showing $EXPANDED_LINKS of ${links.size} links", style = type.caption, color = colors.tertiaryLabel)
        }
        if (links.size > COLLAPSED_LINKS) {
            val more = minOf(links.size, EXPANDED_LINKS) - COLLAPSED_LINKS
            Row(
                Modifier
                    .clip(Radius.smallShape)
                    .clickable(role = Role.Button) { expanded = !expanded }
                    .padding(top = 4.dp, bottom = 4.dp, end = Spacing.xs)
                    .semantics { stateDescription = if (expanded) "Expanded" else "Collapsed" }
                    .testTag("session-links-disclosure"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Icon(
                    if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = null,
                    tint = colors.accent,
                    modifier = Modifier.size(16.dp),
                )
                Text(
                    if (expanded) "Show fewer links" else "Show $more more links",
                    style = type.caption.medium(),
                    color = colors.accent,
                )
            }
        }
    }
}

/** One badge: the link's glyph (the PR glyph in its state's colour for the primary PR) and its short label. */
@Composable
private fun LinkBadge(
    link: WorkLink,
    prState: PrGlyphState?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val what = if (link.kind == WorkLinkKind.PR) "Pull request" else "Ticket"
    Row(
        modifier
            .clip(Radius.smallShape)
            .background(colors.fillTertiary)
            .border(1.dp, colors.separator, Radius.smallShape)
            .clickable(role = Role.Button, onClickLabel = "Open ${link.label}", onClick = onClick)
            .padding(horizontal = 8.dp, vertical = 6.dp)
            .semantics(mergeDescendants = true) { contentDescription = "$what ${link.label}" },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(5.dp),
    ) {
        if (prState != null) {
            PrGlyph(prState, size = 14.dp, contentDescription = null)
        } else {
            Icon(link.glyph, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(14.dp))
        }
        Text(
            shortLinkLabel(link),
            style = OptioTheme.type.caption.mono(),
            color = colors.secondaryLabel,
            maxLines = 1,
            overflow = TextOverflow.MiddleEllipsis,
        )
    }
}
