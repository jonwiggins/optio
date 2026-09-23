package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing

/**
 * A redacted text line (iOS `.redacted(reason: .placeholder)`): a rounded bar in the muted fill,
 * [height] roughly the text's cap height.
 */
@Composable
fun PlaceholderLine(
    width: Dp,
    modifier: Modifier = Modifier,
    height: Dp = 12.dp,
) {
    Box(
        modifier
            .width(width)
            .height(height)
            .clip(RoundedCornerShape(4.dp))
            .background(OptioTheme.colors.fillSecondary),
    )
}

/**
 * Placeholder rows for a list that hasn't loaded (iOS `SkeletonRows`): never a bare spinner. Shaped
 * like [OptioRow] (dot, a title that wraps on alternate rows, a meta line, a trailing time).
 */
@Composable
fun SkeletonRows(
    modifier: Modifier = Modifier,
    count: Int = 3,
    contentPadding: PaddingValues = OptioRowDefaults.ContentPadding,
) {
    Column(modifier.semantics { contentDescription = "Loading" }.testTag("skeleton")) {
        repeat(count) { index ->
            Row(
                Modifier.fillMaxWidth().padding(contentPadding),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                Box(
                    Modifier
                        .padding(top = 7.dp)
                        .size(7.dp)
                        .clip(RoundedCornerShape(50))
                        .background(OptioTheme.colors.fillSecondary),
                )
                Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(9.dp)) {
                    Box(Modifier.height(1.dp))
                    PlaceholderLine(width = if (index % 2 == 0) 230.dp else 120.dp, height = 13.dp)
                    if (index % 2 == 0) PlaceholderLine(width = 150.dp, height = 13.dp)
                    PlaceholderLine(width = 190.dp, height = 11.dp)
                }
                PlaceholderLine(width = 22.dp, height = 10.dp, modifier = Modifier.padding(top = 6.dp))
            }
        }
    }
}

/** Placeholder strip while stats load (iOS `SkeletonStrip`). */
@Composable
fun SkeletonStrip(
    modifier: Modifier = Modifier,
    labels: List<String> = listOf("Running", "Queued", "Needs you", "Failed"),
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(Radius.cardShape)
            .background(colors.card)
            .semantics { contentDescription = "Loading" },
    ) {
        labels.forEachIndexed { index, _ ->
            Column(
                Modifier.weight(1f).padding(horizontal = Spacing.m, vertical = Spacing.m),
                verticalArrangement = Arrangement.spacedBy(10.dp),
            ) {
                PlaceholderLine(width = 26.dp, height = 20.dp)
                PlaceholderLine(width = 48.dp, height = 10.dp)
            }
            if (index < labels.lastIndex) {
                Box(
                    Modifier
                        .padding(vertical = Spacing.m)
                        .fillMaxHeight()
                        .width(Dp.Hairline)
                        .background(colors.separator),
                )
            }
        }
    }
}
