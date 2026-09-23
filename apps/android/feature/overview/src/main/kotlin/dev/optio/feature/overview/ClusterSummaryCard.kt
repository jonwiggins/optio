package dev.optio.feature.overview

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.TextAutoSize
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ShowChart
import androidx.compose.material.icons.outlined.ExpandLess
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.HorizontalDivider
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
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import dev.optio.core.ui.components.NumericText
import dev.optio.core.ui.components.cardSurface
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.tabularNums
import java.util.Locale
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/**
 * The cluster at a glance (iOS `ClusterSummaryCard`, web `cluster-summary.tsx`): the node, the
 * recent spend, nodes / pods / agents / CPU / memory / infra, and on demand the CPU, memory and pod
 * history sampled every 10 s. A lock line for non-admins (the route answers 403). Nothing before
 * the first answer. Test tag: `cluster-summary`.
 */
@Composable
internal fun ClusterSummaryCard(
    cluster: ClusterOverview?,
    forbidden: Boolean,
    totalCost: Double,
    history: List<MetricsSample>,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    if (forbidden) {
        Row(
            modifier.fillMaxWidth().cardSurface().testTag("cluster-summary"),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Icon(Icons.Outlined.Lock, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(16.dp))
            Text("Cluster summary is available to workspace admins.", style = type.footnote, color = colors.secondaryLabel)
        }
        return
    }
    cluster ?: return
    val s = cluster.summary
    val node = cluster.nodes.firstOrNull()
    var showMetrics by rememberSaveable { mutableStateOf(false) }
    Column(
        modifier.fillMaxWidth().cardSurface().testTag("cluster-summary"),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Row(verticalAlignment = Alignment.Bottom, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(
                node?.name.orEmpty(),
                style = type.monoFootnote,
                color = colors.secondaryLabel,
                maxLines = 1,
                overflow = TextOverflow.MiddleEllipsis,
                modifier = Modifier.weight(1f).padding(bottom = 3.dp),
            )
            if (totalCost > 0) {
                NumericText(Cost.format(totalCost), style = type.statValue, color = colors.label)
                Text("recent", style = type.caption, color = colors.secondaryLabel, modifier = Modifier.padding(bottom = 3.dp))
            }
        }
        val metrics = buildList {
            add(Triple("Nodes", "${s.readyNodes}/${s.totalNodes}", if (s.readyNodes < s.totalNodes) Tone.DANGER else null))
            add(Triple("Pods", "${s.runningPods}/${s.totalPods}", null))
            add(Triple("Agents", "${s.agentPods}", null))
            if (node != null) {
                val cores = "${formatLoose(node.cpuCores)} cores"
                add(Triple("CPU", node.cpuUsedPercent?.let { "${it.toInt()}% · $cores" } ?: cores, null))
                val used = node.memoryUsed
                add(Triple("Memory", if (used != null) "${fmt1(used)} / ${fmt1(node.memoryTotal ?: 0.0)} Gi" else InsightsFormat.k8sResource(node.memory), null))
            }
            add(Triple("Infra", "${s.infraPods}", null))
        }
        metrics.chunked(3).forEach { rowItems ->
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                rowItems.forEach { (label, value, tone) -> Metric(label, value, tone, Modifier.weight(1f)) }
                repeat(3 - rowItems.size) { Spacer(Modifier.weight(1f)) }
            }
        }
        if (node != null) {
            Row(
                Modifier
                    .clip(Radius.smallShape)
                    .clickable(role = Role.Button) { showMetrics = !showMetrics }
                    .padding(vertical = 2.dp)
                    .testTag("cluster-metrics-toggle"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
            ) {
                Icon(
                    if (showMetrics) Icons.Outlined.ExpandLess else Icons.AutoMirrored.Outlined.ShowChart,
                    contentDescription = null,
                    tint = colors.secondaryLabel,
                    modifier = Modifier.size(16.dp),
                )
                Text(if (showMetrics) "Hide metrics" else "Show metrics", style = type.footnote, color = colors.secondaryLabel)
            }
        }
        AnimatedVisibility(showMetrics) {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                HorizontalDivider(thickness = 0.5.dp, color = colors.separator)
                when {
                    cluster.metricsAvailable == false -> Text(
                        "metrics-server not detected — CPU and memory charts unavailable.",
                        style = type.footnote,
                        color = colors.tertiaryLabel,
                    )
                    history.size > 1 -> {
                        MiniLine("CPU", history.map { it.cpuPercent ?: 0.0 }, suffix = "%", max = 100.0, color = ChartPalette.color(0))
                        MiniLine("Memory", history.map { it.memoryPercent ?: 0.0 }, suffix = "%", max = 100.0, color = ChartPalette.color(1))
                        MiniLine("Pods", history.map { it.pods.toDouble() }, suffix = "", max = null, color = ChartPalette.color(2))
                        Text(
                            "${history.size} samples · refreshing every 10s",
                            style = type.caption2,
                            color = colors.tertiaryLabel,
                            modifier = Modifier.align(Alignment.End),
                        )
                    }
                    else -> Text("Collecting metrics — graphs appear in a few seconds.", style = type.footnote, color = colors.tertiaryLabel)
                }
            }
        }
    }
}

@Composable
private fun Metric(
    label: String,
    value: String,
    tone: Tone?,
    modifier: Modifier = Modifier,
) {
    Column(modifier, verticalArrangement = Arrangement.spacedBy(1.dp)) {
        Text(
            value,
            style = OptioTheme.type.subheadline.medium().tabularNums(),
            color = tone?.textColor ?: OptioTheme.colors.label,
            maxLines = 1,
            autoSize = TextAutoSize.StepBased(minFontSize = 11.sp, maxFontSize = OptioTheme.type.subheadline.fontSize),
        )
        Text(label, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel, maxLines = 1)
    }
}

/**
 * A compact single-series line with its area (iOS `MiniLine`): the label and latest value, then a
 * 44dp chart from 0 to [max] (or the series' own maximum), monotone-interpolated like Swift Charts.
 */
@Composable
private fun MiniLine(
    label: String,
    values: List<Double>,
    suffix: String,
    max: Double?,
    color: Color,
) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Text(label, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.weight(1f))
            NumericText(
                "${(values.lastOrNull() ?: 0.0).toInt()}$suffix",
                style = OptioTheme.type.caption.medium().tabularNums(),
                color = OptioTheme.colors.label,
            )
        }
        val top = max ?: max(values.maxOrNull() ?: 1.0, 1.0)
        Canvas(Modifier.fillMaxWidth().height(44.dp)) {
            if (values.size < 2) return@Canvas
            val points = values.mapIndexed { i, v ->
                Offset(
                    x = size.width * i / (values.size - 1),
                    y = size.height * (1 - (v / top).coerceIn(0.0, 1.0)).toFloat(),
                )
            }
            val line = monotonePath(points)
            val area = monotonePath(points).apply {
                lineTo(points.last().x, size.height)
                lineTo(points.first().x, size.height)
                close()
            }
            drawPath(area, color.copy(alpha = ChartPalette.AREA_ALPHA))
            drawPath(line, color, style = Stroke(width = 1.5.dp.toPx(), cap = StrokeCap.Round, join = StrokeJoin.Round))
        }
    }
}

/**
 * A monotone cubic through [points] (Fritsch–Carlson, what Swift Charts' `.monotone` draws): smooth,
 * and never overshooting between samples, so a flat 0 stays flat.
 */
internal fun monotonePath(points: List<Offset>): Path {
    val path = Path()
    if (points.isEmpty()) return path
    path.moveTo(points[0].x, points[0].y)
    if (points.size == 1) return path
    val n = points.size
    val dx = FloatArray(n - 1) { points[it + 1].x - points[it].x }
    val slope = FloatArray(n - 1) { if (dx[it] == 0f) 0f else (points[it + 1].y - points[it].y) / dx[it] }
    val tangent = FloatArray(n)
    tangent[0] = slope[0]
    tangent[n - 1] = slope[n - 2]
    for (i in 1 until n - 1) {
        tangent[i] = if (slope[i - 1] * slope[i] <= 0f) 0f else (slope[i - 1] + slope[i]) / 2f
    }
    for (i in 0 until n - 1) {
        if (slope[i] == 0f) {
            tangent[i] = 0f
            tangent[i + 1] = 0f
            continue
        }
        val a = tangent[i] / slope[i]
        val b = tangent[i + 1] / slope[i]
        val h = a * a + b * b
        if (h > 9f) {
            val t = 3f / sqrt(h)
            tangent[i] = t * a * slope[i]
            tangent[i + 1] = t * b * slope[i]
        }
    }
    for (i in 0 until n - 1) {
        val third = dx[i] / 3f
        path.cubicTo(
            points[i].x + third, points[i].y + tangent[i] * third,
            points[i + 1].x - third, points[i + 1].y - tangent[i + 1] * third,
            points[i + 1].x, points[i + 1].y,
        )
    }
    return path
}

private fun formatLoose(value: Double?): String {
    val d = value ?: return "?"
    return if (abs(d - Math.rint(d)) < 1e-9) d.toLong().toString() else fmt1(d)
}

private fun fmt1(value: Double): String = String.format(Locale.US, "%.1f", value)
