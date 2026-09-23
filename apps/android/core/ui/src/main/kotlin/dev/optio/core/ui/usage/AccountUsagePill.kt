package dev.optio.core.ui.usage

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Speed
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.CornerRadius
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.NumericText
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.semibold

/**
 * Compact "Claude 5h 31% · 7d 52%" for session headers (iOS `AccountUsagePill`, web
 * `usage-chips.tsx`): tinted by the worst window (yellow ≥ 80%, red ≥ 95%), dashed and dimmed
 * while the numbers are stale; tap for [UsageBreakdownSheet]. Hidden until the store has numbers.
 * Test tag: `usage-pill`.
 */
@Composable
fun AccountUsagePill(
    modifier: Modifier = Modifier,
    store: UsageStore? = LocalUsageStore.current,
) {
    store ?: return
    val buckets = store.claudeBuckets
    if (buckets.isEmpty()) return
    var showBreakdown by remember { mutableStateOf(false) }
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val worst = UsageLimits.percent(buckets.maxOf { it.window.usedPercent })
    val severity = UsageSeverity.of(worst)
    val stale = store.usage?.stale == true
    val border: Color? = when {
        severity.isElevated -> severity.tone.color.copy(alpha = 0.4f)
        stale -> colors.tertiaryLabel
        else -> null
    }
    val open = { showBreakdown = true }
    Row(
        modifier = modifier
            .alpha(if (stale) 0.7f else 1f)
            .clip(Radius.capsuleShape)
            .background(if (severity.isElevated) severity.tone.color.copy(alpha = 0.14f) else colors.fillTertiary)
            .drawBehind {
                if (border != null) {
                    val stroke = 1.dp.toPx()
                    drawRoundRect(
                        color = border,
                        topLeft = Offset(stroke / 2, stroke / 2),
                        size = Size(size.width - stroke, size.height - stroke),
                        cornerRadius = CornerRadius(size.height / 2),
                        style = Stroke(
                            width = stroke,
                            pathEffect = if (stale) PathEffect.dashPathEffect(floatArrayOf(3.dp.toPx(), 3.dp.toPx())) else null,
                        ),
                    )
                }
            }
            .clickable(role = Role.Button, onClick = open)
            .padding(horizontal = Spacing.s, vertical = 4.dp)
            .clearAndSetSemantics { contentDescription = "Claude usage: worst window $worst percent. Tap for details." }
            .testTag("usage-pill"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        Icon(
            Icons.Outlined.Speed,
            contentDescription = null,
            tint = if (severity.isElevated) severity.tone.textColor else colors.secondaryLabel,
            modifier = Modifier.size(12.dp),
        )
        Text("Claude", style = type.monoCaption, color = colors.secondaryLabel, maxLines = 1)
        buckets.forEach { bucket ->
            val pct = UsageLimits.percent(bucket.window.usedPercent)
            val s = UsageSeverity.of(pct)
            Row(horizontalArrangement = Arrangement.spacedBy(3.dp), verticalAlignment = Alignment.CenterVertically) {
                Text(bucket.label, style = type.monoCaption, color = colors.tertiaryLabel, maxLines = 1)
                NumericText(
                    "$pct%",
                    style = type.monoCaption.medium(),
                    color = if (s.isElevated) s.tone.textColor else colors.label,
                )
            }
        }
    }
    if (showBreakdown) UsageBreakdownSheet(onDismiss = { showBreakdown = false }, store = store)
}

/**
 * The pill's expansion (iOS `UsageBreakdownSheet`): token banners, the full [LimitsPanel] and the
 * account footnote (or the stale note) in a bottom sheet, polling while open. Test tag:
 * `usage-breakdown`.
 */
@Composable
fun UsageBreakdownSheet(
    onDismiss: () -> Unit,
    store: UsageStore? = LocalUsageStore.current,
) {
    store ?: return
    ObservesUsage(store)
    val sheetState = rememberModalBottomSheetState()
    ProvideElevatedSurfaces {
        ModalBottomSheet(
            onDismissRequest = onDismiss,
            sheetState = sheetState,
            containerColor = OptioTheme.colors.page,
        ) {
            UsageBreakdownContent(store, onDone = onDismiss)
        }
    }
}

/** The breakdown sheet's body, also usable on its own (a pushed screen, a screenshot). */
@Composable
fun UsageBreakdownContent(
    store: UsageStore,
    modifier: Modifier = Modifier,
    onDone: (() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.l)
            .navigationBarsPadding()
            .padding(bottom = Spacing.l)
            .testTag("usage-breakdown"),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text("Usage limits", style = type.headline, color = colors.label)
            Spacer(Modifier.weight(1f))
            if (onDone != null) TextButton(onClick = onDone) { Text("Done", style = type.body.semibold()) }
        }
        UsageTokenBanners(store = store)
        LimitsPanel(store = store)
        val usage = store.usage
        val now = rememberNow()
        if (usage != null && usage.stale == true) {
            val age = usage.asOf?.let { " from ${UsageLimits.staleAge(it, now)} ago" }.orEmpty()
            Text(
                "Last known values$age — the latest read failed (${usage.error ?: "unavailable"}); retrying automatically",
                style = type.caption,
                color = colors.yellow,
                modifier = Modifier.padding(horizontal = Spacing.xs),
            )
        } else {
            Text(
                "Account-wide, refreshed every few minutes.",
                style = type.caption,
                color = colors.tertiaryLabel,
                modifier = Modifier.padding(horizontal = Spacing.xs),
            )
        }
    }
}
