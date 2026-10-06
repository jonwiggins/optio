package dev.optio.core.ui.components

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.SizeTransform
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone

/**
 * One tile of a [StatStrip] (iOS `StatItem`). [isZero] renders the value tertiary so an idle
 * screen has no colour; only [Tone.ACCENT] (needs you) and [Tone.DANGER] (failed) are honoured,
 * and only when non-zero. [key] identifies the tile for [StatStrip]'s selection.
 */
@Immutable
data class StatItem(
    val label: String,
    val value: String,
    val isZero: Boolean = false,
    val tone: Tone? = null,
    val key: String = label,
) {
    /** A count tile: zero is dimmed. */
    constructor(label: String, count: Int, tone: Tone? = null, key: String = label) :
        this(label = label, value = count.toString(), isZero = count == 0, tone = tone, key = key)
}

/**
 * Flat stat strip (iOS `StatStrip`): one card, hairline dividers, value over label. With
 * [onSelect] the tiles become a filter; [selected] (a tile's [StatItem.key]) gets a 2dp underline.
 * Values animate when they change. At most five tiles.
 */
@Composable
fun StatStrip(
    items: List<StatItem>,
    modifier: Modifier = Modifier,
    selected: String? = null,
    onSelect: ((StatItem) -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val haptics = LocalHapticFeedback.current
    androidx.compose.foundation.layout.BoxWithConstraints(modifier.fillMaxWidth()) {
        val columns = (maxWidth / 112.dp).toInt().coerceIn(1, items.size.coerceAtLeast(1))
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            items.chunked(columns).forEach { group ->
                Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    group.forEach { item ->
                        val isSelected = selected == item.key
                        val tap = if (onSelect != null) Modifier.clickable(role = Role.Tab) {
                            haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                            onSelect(item)
                        } else Modifier
                        Column(
                            Modifier.weight(1f).clip(Radius.smallShape)
                                .background(if (isSelected) colors.accent.copy(alpha = 0.1f) else colors.card)
                                .then(tap).testTag("stat-${item.key}")
                                .clearAndSetSemantics {
                                    contentDescription = "${item.label}: ${item.value}"
                                    if (onSelect != null) { role = Role.Tab; this.selected = isSelected }
                                }.padding(Spacing.m),
                            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                        ) {
                            NumericText(item.value, style = OptioTheme.type.statValue, color = statValueColor(item))
                            Text(item.label, style = OptioTheme.type.caption, color = colors.secondaryLabel, maxLines = 2)
                        }
                    }
                }
            }
        }
    }
}

@Composable
private fun statValueColor(item: StatItem): Color = when {
    item.isZero -> OptioTheme.colors.tertiaryLabel
    item.tone == Tone.ACCENT || item.tone == Tone.DANGER -> item.tone.textColor
    else -> OptioTheme.colors.label
}

/**
 * Text that animates when its value changes (iOS `.contentTransition(.numericText())`): the new
 * value rolls up when a number grows and down when it shrinks. Use for every number that polls.
 */
@Composable
fun NumericText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = OptioTheme.type.body,
    color: Color = Color.Unspecified,
    autoSize: TextAutoSize? = null,
) {
    AnimatedContent(
        targetState = text,
        modifier = modifier,
        transitionSpec = {
            val up = (targetState.numericValue() ?: 0.0) >= (initialState.numericValue() ?: 0.0)
            val direction = if (up) 1 else -1
            (slideInVertically { height -> direction * height / 2 } + fadeIn())
                .togetherWith(slideOutVertically { height -> -direction * height / 2 } + fadeOut())
                .using(SizeTransform(clip = false))
        },
        label = "numeric-text",
    ) { value ->
        Text(value, style = style, color = color, maxLines = 1, softWrap = false, autoSize = autoSize)
    }
}

private fun String.numericValue(): Double? = filter { it.isDigit() || it == '.' || it == '-' }.toDoubleOrNull()
