package dev.optio.feature.insights

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.patrykandpatrick.vico.compose.cartesian.CartesianChartHost
import com.patrykandpatrick.vico.compose.cartesian.axis.HorizontalAxis
import com.patrykandpatrick.vico.compose.cartesian.axis.VerticalAxis
import com.patrykandpatrick.vico.compose.cartesian.axis.rememberAxisGuidelineComponent
import com.patrykandpatrick.vico.compose.cartesian.axis.rememberAxisLabelComponent
import com.patrykandpatrick.vico.compose.cartesian.axis.rememberAxisLineComponent
import com.patrykandpatrick.vico.compose.cartesian.data.CartesianChartModel
import com.patrykandpatrick.vico.compose.cartesian.data.CartesianLayerRangeProvider
import com.patrykandpatrick.vico.compose.cartesian.data.CartesianValueFormatter
import com.patrykandpatrick.vico.compose.cartesian.data.ColumnCartesianLayerModel
import com.patrykandpatrick.vico.compose.cartesian.data.LineCartesianLayerModel
import com.patrykandpatrick.vico.compose.cartesian.layer.ColumnCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.layer.LineCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberColumnCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberLine
import com.patrykandpatrick.vico.compose.cartesian.layer.rememberLineCartesianLayer
import com.patrykandpatrick.vico.compose.cartesian.rememberCartesianChart
import com.patrykandpatrick.vico.compose.cartesian.rememberVicoScrollState
import com.patrykandpatrick.vico.compose.common.Fill
import com.patrykandpatrick.vico.compose.common.component.rememberLineComponent
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import java.time.LocalDate
import java.time.format.DateTimeFormatter
import java.util.Locale
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.log10
import kotlin.math.max
import kotlin.math.pow

/** Axis helpers shared by the Insights charts (pure: unit tested). */
internal object ChartScale {
    private val dayLabel: DateTimeFormatter = DateTimeFormatter.ofPattern("MMM d", Locale.US)

    /** "Sep 17" for an epoch day (iOS `.dateTime.month(.abbreviated).day()`). */
    fun dayLabel(epochDay: Double): String = dayLabel.format(LocalDate.ofEpochDay(floor(epochDay + 0.5).toLong()))

    /** A 1 / 2 / 5 × 10ⁿ step giving about [target] intervals up to [max]; at least 1 when [integers]. */
    fun niceStep(max: Double, target: Int = 4, integers: Boolean = false): Double {
        if (!(max > 0)) return 1.0
        val raw = max / target
        val magnitude = 10.0.pow(floor(log10(raw)))
        val normalized = raw / magnitude
        val nice = when {
            normalized <= 1 -> 1.0
            normalized <= 2 -> 2.0
            normalized <= 5 -> 5.0
            else -> 10.0
        } * magnitude
        return if (integers) max(1.0, ceil(nice)) else nice
    }

    /** The axis top: [max] rounded up to a whole [step] (at least one step). */
    fun niceMax(max: Double, step: Double): Double = max(step, ceil(max / step) * step)

    /** First day shown: at least a week wide so one bucket doesn't fill the chart. */
    fun minDay(days: List<Long>): Long = if (days.isEmpty()) 0 else minOf(days.min(), days.max() - 6)

    /** Label every [labelSpacing]-th day so about five labels fit. */
    fun labelSpacing(minDay: Long, maxDay: Long): Int = max(1, ceil((maxDay - minDay + 1) / 5.0).toInt())
}

private val axisTextSize = 10.sp

/** One day's stacked bar: succeeded under failed. */
internal data class DayBar(val epochDay: Long, val succeeded: Int, val failed: Int)

/**
 * "Tasks over time" (iOS stacked `BarMark`s): succeeded under failed per day, a legend on top, a
 * leading count axis and "Sep 17" day labels.
 */
@Composable
internal fun TasksOverTimeChart(
    bars: List<DayBar>,
    modifier: Modifier = Modifier,
    height: Dp = ChartPalette.primaryHeight,
) {
    if (bars.isEmpty()) return
    val succeededColor = ChartPalette.color(1)
    val failedColor = OptioTheme.colors.red.copy(alpha = 0.8f)
    val days = bars.map { it.epochDay }
    val minDay = ChartScale.minDay(days)
    val maxDay = days.max()
    val top = bars.maxOf { it.succeeded + it.failed }.toDouble()
    val step = ChartScale.niceStep(top, integers = true)
    val model = remember(bars) {
        CartesianChartModel(
            ColumnCartesianLayerModel.build {
                series(x = days, y = bars.map { it.succeeded })
                series(x = days, y = bars.map { it.failed })
            },
        )
    }
    Legend(listOf("Succeeded" to succeededColor, "Failed" to failedColor))
    val layer = rememberColumnCartesianLayer(
        columnProvider = ColumnCartesianLayer.ColumnProvider.series(
            rememberLineComponent(Fill(succeededColor), thickness = 10.dp),
            rememberLineComponent(Fill(failedColor), thickness = 10.dp),
        ),
        mergeMode = { ColumnCartesianLayer.MergeMode.Stacked },
        rangeProvider = remember(minDay, maxDay, top, step) {
            CartesianLayerRangeProvider.fixed(minX = minDay.toDouble(), maxX = maxDay.toDouble(), minY = 0.0, maxY = ChartScale.niceMax(top, step))
        },
    )
    Chart(
        layer = layer,
        model = model,
        yStep = step,
        yFormatter = remember { CartesianValueFormatter.decimal(decimalCount = 0) },
        labelSpacing = ChartScale.labelSpacing(minDay, maxDay),
        height = height,
        description = "Tasks over time: ${bars.sumOf { it.succeeded }} succeeded, ${bars.sumOf { it.failed }} failed",
        modifier = modifier.testTag("chart-tasks-over-time"),
    )
}

/** One day's cost. */
internal data class DayCost(val epochDay: Long, val cost: Double)

/**
 * "Cost over time" (iOS `AreaMark` + `LineMark`, monotone): a line over a faint area with a
 * leading dollar axis. A single day shows as a bar, since a line needs two points.
 */
@Composable
internal fun CostOverTimeChart(
    points: List<DayCost>,
    modifier: Modifier = Modifier,
    height: Dp = ChartPalette.primaryHeight,
) {
    if (points.isEmpty()) return
    val color = ChartPalette.color(1)
    val days = points.map { it.epochDay }
    val minDay = ChartScale.minDay(days)
    val maxDay = days.max()
    val top = points.maxOf { it.cost }
    val step = ChartScale.niceStep(top)
    val range = remember(minDay, maxDay, top, step) {
        CartesianLayerRangeProvider.fixed(minX = minDay.toDouble(), maxX = maxDay.toDouble(), minY = 0.0, maxY = ChartScale.niceMax(top, step))
    }
    val yFormatter = remember { CartesianValueFormatter { _, value, _ -> Cost.format(value) } }
    val description = "Cost over time: ${Cost.format(points.sumOf { it.cost })} over ${points.size} days"
    if (points.size < 2) {
        val model = remember(points) { CartesianChartModel(ColumnCartesianLayerModel.build { series(x = days, y = points.map { it.cost }) }) }
        val layer = rememberColumnCartesianLayer(
            columnProvider = ColumnCartesianLayer.ColumnProvider.series(rememberLineComponent(Fill(color), thickness = 10.dp)),
            rangeProvider = range,
        )
        Chart(layer, model, step, yFormatter, ChartScale.labelSpacing(minDay, maxDay), height, description, modifier.testTag("chart-cost-over-time"))
        return
    }
    val model = remember(points) { CartesianChartModel(LineCartesianLayerModel.build { series(x = days, y = points.map { it.cost }) }) }
    val layer = rememberLineCartesianLayer(
        lineProvider = LineCartesianLayer.LineProvider.series(
            LineCartesianLayer.rememberLine(
                fill = remember(color) { LineCartesianLayer.LineFill.single(Fill(color)) },
                stroke = remember { LineCartesianLayer.LineStroke.Continuous(thickness = 1.5.dp) },
                areaFill = remember(color) { LineCartesianLayer.AreaFill.single(Fill(color.copy(alpha = ChartPalette.AREA_ALPHA))) },
                interpolator = remember { LineCartesianLayer.Interpolator.cubic() },
            ),
        ),
        rangeProvider = range,
    )
    Chart(layer, model, step, yFormatter, ChartScale.labelSpacing(minDay, maxDay), height, description, modifier.testTag("chart-cost-over-time"))
}

/** The shared chart frame: leading value axis with hairline guides, bottom day labels, no scrolling. */
@Composable
private fun Chart(
    layer: com.patrykandpatrick.vico.compose.cartesian.layer.CartesianLayer<*>,
    model: CartesianChartModel,
    yStep: Double,
    yFormatter: CartesianValueFormatter,
    labelSpacing: Int,
    height: Dp,
    description: String,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val label = rememberAxisLabelComponent(style = TextStyle(color = colors.secondaryLabel, fontSize = axisTextSize))
    val guideline = rememberAxisGuidelineComponent(fill = Fill(colors.separator), thickness = 0.5.dp, shape = androidx.compose.ui.graphics.RectangleShape)
    val baseline = rememberAxisLineComponent(fill = Fill(colors.separator), thickness = 0.5.dp)
    val chart = rememberCartesianChart(
        layer,
        startAxis = VerticalAxis.rememberStart(
            line = null,
            label = label,
            valueFormatter = yFormatter,
            tick = null,
            guideline = guideline,
            itemPlacer = remember(yStep) { VerticalAxis.ItemPlacer.step(step = { yStep }) },
        ),
        bottomAxis = HorizontalAxis.rememberBottom(
            line = baseline,
            label = label,
            valueFormatter = remember { CartesianValueFormatter { _, value, _ -> ChartScale.dayLabel(value) } },
            tick = null,
            guideline = null,
            itemPlacer = remember(labelSpacing) { HorizontalAxis.ItemPlacer.aligned(spacing = { labelSpacing }) },
        ),
    )
    CartesianChartHost(
        chart = chart,
        model = model,
        modifier = modifier.fillMaxWidth().height(height).semantics { contentDescription = description },
        scrollState = rememberVicoScrollState(scrollEnabled = false),
    )
}

/** A row of coloured dots and labels (iOS `chartLegend(position: .top)`). */
@Composable
internal fun Legend(items: List<Pair<String, Color>>, modifier: Modifier = Modifier) {
    Row(modifier, horizontalArrangement = Arrangement.spacedBy(Spacing.m), verticalAlignment = Alignment.CenterVertically) {
        items.forEach { (label, color) ->
            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                Box(Modifier.size(8.dp).background(color, CircleShape))
                Text(label, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
            }
        }
    }
}

/**
 * One capsule split into [values]' shares in the chart palette (iOS "Cost by task type": a single
 * horizontal stacked `BarMark`).
 */
@Composable
internal fun ShareBar(
    values: List<Double>,
    modifier: Modifier = Modifier,
    height: Dp = 24.dp,
) {
    val total = values.sum()
    if (!(total > 0)) return
    val palette = ChartPalette.series
    Row(
        modifier
            .fillMaxWidth()
            .height(height)
            .clip(Radius.smallShape),
        horizontalArrangement = Arrangement.spacedBy(1.dp),
    ) {
        values.forEachIndexed { index, value ->
            if (value > 0) {
                Box(Modifier.weight((value / total).toFloat()).fillMaxHeight().background(palette[index.mod(palette.size)]))
            }
        }
    }
}

/** `Sep 17` epoch days of analytics buckets ("2026-09-17" or ISO), for the charts. */
internal fun epochDay(date: String): Long? = InsightsFormat.day(date, java.time.ZoneOffset.UTC)?.toEpochDay()
