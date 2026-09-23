package dev.optio.core.ui.components

import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.tabularNums

/**
 * The card surface on the grouped page (iOS `cardSurface()`): the one card colour, the card
 * radius, [padding] inside. No stroke, no shadow.
 */
@Composable
fun Modifier.cardSurface(padding: Dp = Spacing.m): Modifier =
    this.clip(Radius.cardShape).background(OptioTheme.colors.card).padding(padding)

/** Filter changes keep the old content dimmed instead of blanking it (iOS `dimmedWhileLoading`). */
@Composable
fun Modifier.dimmedWhileLoading(loading: Boolean): Modifier {
    val alpha by animateFloatAsState(if (loading) 0.5f else 1f, label = "dimmed")
    return this.alpha(alpha)
}

/** A card: [cardSurface] around a column of [content]. */
@Composable
fun OptioCard(
    modifier: Modifier = Modifier,
    contentPadding: Dp = Spacing.m,
    verticalArrangement: Arrangement.Vertical = Arrangement.spacedBy(Spacing.s),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth().cardSurface(contentPadding), verticalArrangement = verticalArrangement, content = content)
}

/**
 * An inset-grouped section (iOS `.insetGrouped` list section) for detail, settings and config
 * screens: an optional [header], rows on one card, an optional [footer]. Separate rows with
 * [InsetDivider]; rows bring their own padding ([OptioRow], [KeyValueRow]).
 */
@Composable
fun GroupedSection(
    modifier: Modifier = Modifier,
    header: String? = null,
    footer: String? = null,
    headerAction: (() -> Unit)? = null,
    contentPadding: PaddingValues = PaddingValues(horizontal = Spacing.l),
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(modifier.fillMaxWidth().padding(contentPadding)) {
        if (header != null) {
            SectionHeader(
                header,
                action = headerAction,
                contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
            )
        }
        Column(Modifier.fillMaxWidth().clip(Radius.cardShape).background(OptioTheme.colors.card), content = content)
        if (footer != null) {
            Text(
                footer,
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.padding(start = Spacing.l, end = Spacing.l, top = Spacing.s),
            )
        }
    }
}

/**
 * Card with a sentence-case caption title, matching the web's panels (iOS `InsightCard`): Insights
 * and Overview charts and breakdowns.
 */
@Composable
fun InsightCard(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    trailing: (@Composable () -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    Column(
        modifier.fillMaxWidth().cardSurface(),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
            if (icon != null) Icon(icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(16.dp))
            Text(title, style = OptioTheme.type.sectionHeader, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.weight(1f))
            trailing?.invoke()
        }
        content()
    }
}

/**
 * A thin capsule meter: [fraction] (clamped to 0…1) of [color] over the quiet fill. The bar under
 * [RateBar] and the usage [LimitMeter][dev.optio.core.ui.usage.LimitMeter].
 */
@Composable
fun MeterBar(
    fraction: Double,
    modifier: Modifier = Modifier,
    color: Color = ChartPalette.color(1),
    height: Dp = 5.dp,
) {
    Box(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(Radius.capsuleShape)
            .background(OptioTheme.colors.fillSecondary),
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .fillMaxWidth(fraction.coerceIn(0.0, 1.0).toFloat())
                .clip(Radius.capsuleShape)
                .background(color),
        )
    }
}

/** Label · value · thin bar, for "rate by repo / model" lists (iOS `RateBar`). */
@Composable
fun RateBar(
    label: String,
    valueText: String,
    fraction: Double,
    modifier: Modifier = Modifier,
    color: Color = ChartPalette.color(1),
) {
    Column(
        modifier.fillMaxWidth().semantics(mergeDescendants = true) { contentDescription = "$label: $valueText" },
        verticalArrangement = Arrangement.spacedBy(3.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(
                label,
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            NumericText(valueText, style = OptioTheme.type.footnote.tabularNums(), color = OptioTheme.colors.secondaryLabel)
        }
        MeterBar(fraction = fraction, color = color)
    }
}
