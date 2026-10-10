package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.model.WorkLink
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.usage.AccountUsagePill
import dev.optio.core.ui.usage.ObservesUsage

/**
 * The runtime's mark with a status dot at its bottom-right corner (iOS `GlyphView` + `StateDot`
 * overlay; the web session rail's avatar). Shared by work cards and session headers. A plain
 * shell draws the terminal glyph; the dot sits on a ring of [ring] (the card's colour) so it reads
 * over the mark.
 */
@Composable
fun RuntimeMark(
    runtime: String?,
    tone: Tone,
    modifier: Modifier = Modifier,
    size: Dp = 36.dp,
    ring: Color = OptioTheme.colors.card,
    contentDescription: String? = null,
) {
    Box(modifier.size(size)) {
        AgentMark(
            runtime = runtime,
            size = size,
            contentDescription = contentDescription,
            tint = OptioTheme.colors.secondaryLabel,
        )
        Box(
            Modifier
                .align(Alignment.BottomEnd)
                .offset(x = 3.dp, y = 3.dp)
                .background(ring, CircleShape)
                .padding(2.dp),
        ) {
            StateDot(tone, size = 8.dp, pulse = false)
        }
    }
}

/**
 * The identity of a session, above the conversation controls (iOS `SessionIdentityHeader`, the
 * v0.15 session header): the runtime's mark with its status dot, the title and its place (a
 * directory, a repo), then the status beside the usage pill, optional [facts] (`host · exit 0 ·
 * $0.12`), an error [message] in the status tone, the PR / ticket badges (two at rest, at most
 * eight expanded, scrolling within [LINKS_HEIGHT]), and [controls] (a Chat / Terminal switch).
 * The links never compete with the controls for the same line.
 *
 * [showsUsage] adds the shared account usage pill and keeps the usage poller running while the
 * header is on screen (it needs `LocalUsageStore`; without it the pill is simply absent).
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun SessionIdentityHeader(
    title: String,
    runtime: String?,
    status: String,
    tone: Tone,
    location: String,
    modifier: Modifier = Modifier,
    facts: AnnotatedString? = null,
    message: String? = null,
    links: List<WorkLink> = emptyList(),
    showsUsage: Boolean = false,
    onOpenLink: ((String) -> Unit)? = null,
    controls: @Composable () -> Unit = {},
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    if (showsUsage) ObservesUsage()
    Column(
        modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .testTag("detail-header"),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(Spacing.m)) {
                RuntimeMark(
                    runtime = runtime,
                    tone = tone,
                    size = 32.dp,
                    ring = MaterialTheme.colorScheme.surfaceContainerLow,
                    contentDescription = runtimeName(runtime),
                    modifier = Modifier.padding(top = 3.dp),
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Text(
                        title,
                        style = type.headline,
                        color = colors.label,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.testTag("session-title"),
                    )
                    SelectionContainer {
                        Text(
                            location,
                            style = type.monoCaption,
                            color = colors.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.MiddleEllipsis,
                        )
                    }
                }
            }
            FlowRow(
                Modifier.fillMaxWidth(),
                horizontalArrangement = Arrangement.SpaceBetween,
                verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                itemVerticalAlignment = Alignment.CenterVertically,
            ) {
                Text(
                    status,
                    style = type.subheadline.medium(),
                    color = tone.textColor,
                    modifier = Modifier.padding(end = Spacing.s).testTag("session-status"),
                )
                if (showsUsage) AccountUsagePill()
            }
            if (facts != null && facts.isNotEmpty()) {
                Text(facts, style = type.caption, color = colors.secondaryLabel)
            }
            if (!message.isNullOrEmpty()) {
                Text(message, style = type.caption, color = tone.textColor, maxLines = 2, overflow = TextOverflow.Ellipsis)
            }
            SessionLinkBadges(links = links, expandedHeight = LINKS_HEIGHT, onOpen = onOpenLink, primaryTag = "work-link")
            controls()
        }
        InsetDivider(start = 0.dp)
    }
}

/** How tall the expanded badge list may grow in a header (iOS `expandedHeight: 160`). */
val LINKS_HEIGHT: Dp = 160.dp

/** The runtime's name for accessibility: "Claude Code", "terminal", … */
private fun runtimeName(runtime: String?): String {
    AgentBrand.from(runtime)?.let { return it.label }
    return when (runtime?.trim()?.lowercase()) {
        null, "", "terminal", "shell" -> "terminal"
        else -> runtime
    }
}
