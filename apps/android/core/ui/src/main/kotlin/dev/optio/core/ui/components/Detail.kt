package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.usage.AccountUsagePill
import dev.optio.core.ui.usage.ObservesUsage

/**
 * The standard header of detail screens (iOS `DetailHeader`: Task, Job run, Review, Agent,
 * Session, Local terminal): the [state] badge and a title-less `·`-joined [line] (`Running · 3m 12s
 * · Sonnet`), an optional mono [secondary] line (path, branch, PR), and a single accent row only
 * when the thing [needsYou]. [accessory] sits at the end of the badge row (a PR link button).
 *
 * [lineMaxLines] lets a long [line] wrap under itself instead of losing its middle (one line by
 * default, cut in the middle like iOS; a middle cut can split a value such as `$0.0…1k`).
 *
 * [secondaryTruncation] cuts a [secondary] line that doesn't fit: at the start by default, so a
 * path keeps its leaf; free text such as a description reads better cut at the end
 * ([Truncation.END]).
 *
 * [showsUsage] adds the shared Claude usage pill ([AccountUsagePill]) after the secondary line (on
 * the same line when both fit) and keeps the usage poller running while the header is on screen
 * ([ObservesUsage]). Both need `LocalUsageStore`; without it the pill is simply absent.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun DetailHeader(
    state: String,
    modifier: Modifier = Modifier,
    tone: Tone? = null,
    line: AnnotatedString? = null,
    lineMaxLines: Int = 1,
    secondary: AnnotatedString? = null,
    secondaryTruncation: Truncation = Truncation.HEAD,
    needsYou: String? = null,
    showsUsage: Boolean = false,
    accessory: @Composable RowScope.() -> Unit = {},
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    if (showsUsage) ObservesUsage()
    Column(
        modifier = modifier
            .fillMaxWidth()
            .background(MaterialTheme.colorScheme.surfaceContainerLow)
            .testTag("detail-header"),
    ) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                StatusBadge(text = state, tone = tone ?: Tone.forState(state))
                Box(Modifier.weight(1f)) {
                    if (line != null) {
                        Text(
                            line,
                            style = type.subheadline,
                            color = colors.secondaryLabel,
                            maxLines = lineMaxLines,
                            overflow = if (lineMaxLines == 1) TextOverflow.MiddleEllipsis else TextOverflow.Ellipsis,
                        )
                    }
                }
                CompositionLocalProvider(LocalContentColor provides colors.secondaryLabel) { accessory() }
            }
            when {
                secondary != null && showsUsage -> FlowRow(
                    modifier = Modifier.fillMaxWidth(),
                    horizontalArrangement = Arrangement.SpaceBetween,
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                    itemVerticalAlignment = Alignment.CenterVertically,
                ) {
                    SecondaryLine(secondary, secondaryTruncation, Modifier.padding(end = Spacing.s))
                    AccountUsagePill()
                }
                secondary != null -> SecondaryLine(secondary, secondaryTruncation)
                showsUsage -> AccountUsagePill()
            }
            if (needsYou != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    StateDot(Tone.ACCENT)
                    Text(needsYou, style = type.footnote.medium(), color = Tone.ACCENT.textColor)
                }
            }
        }
        InsetDivider(start = 0.dp)
    }
}

@Composable
private fun SecondaryLine(text: AnnotatedString, truncation: Truncation, modifier: Modifier = Modifier) {
    Text(
        text,
        style = OptioTheme.type.monoFootnote,
        color = OptioTheme.colors.secondaryLabel,
        maxLines = 1,
        overflow = truncation.overflow,
        modifier = modifier,
    )
}

/** Who wrote a [MessageBubble]. */
enum class MessageRole { USER, AGENT, SYSTEM }

/**
 * One chat message (iOS `MessageBubble`): the user's is trailing on a quiet fill, the agent's
 * leading plain prose (no bubble) rendered as Markdown, a system note footnote-secondary. [meta]
 * (time, delivery) sits under it, accent while [pending].
 */
@Composable
fun MessageBubble(
    role: MessageRole,
    text: String,
    modifier: Modifier = Modifier,
    meta: String? = null,
    pending: Boolean = false,
    maxBubbleWidth: Dp = 320.dp,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val alignment = if (role == MessageRole.USER) Alignment.End else Alignment.Start
    Column(modifier.fillMaxWidth(), horizontalAlignment = alignment, verticalArrangement = Arrangement.spacedBy(3.dp)) {
        when (role) {
            MessageRole.USER -> SelectionContainer {
                Text(
                    text,
                    style = type.body,
                    color = colors.label,
                    modifier = Modifier
                        .widthIn(max = maxBubbleWidth)
                        .background(colors.fillSecondary, Radius.bubbleShape)
                        .padding(horizontal = Spacing.m, vertical = Spacing.s),
                )
            }
            MessageRole.AGENT -> SelectionContainer(Modifier.fillMaxWidth()) {
                MarkdownText(text)
            }
            MessageRole.SYSTEM -> Text(text, style = type.footnote, color = colors.secondaryLabel)
        }
        if (meta != null) {
            Text(meta, style = type.caption2, color = if (pending) colors.accent else colors.tertiaryLabel)
        }
    }
}

/**
 * Monochrome pipeline strip (iOS `PipelineStrip`, the review detail's stages): done steps in the
 * label colour, the [current] one accent (red when [failed]), future ones quaternary.
 */
@Composable
fun PipelineStrip(
    steps: List<String>,
    current: Int,
    modifier: Modifier = Modifier,
    failed: Boolean = false,
) {
    val colors = OptioTheme.colors
    Row(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        steps.forEachIndexed { index, step ->
            val fill = when {
                index < current -> colors.label
                index == current -> if (failed) colors.red else colors.accent
                else -> colors.quaternaryLabel
            }
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                Box(Modifier.fillMaxWidth().height(3.dp).background(fill, Radius.capsuleShape))
                Text(
                    step,
                    style = OptioTheme.type.caption2,
                    color = if (index <= current) colors.label else colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}
