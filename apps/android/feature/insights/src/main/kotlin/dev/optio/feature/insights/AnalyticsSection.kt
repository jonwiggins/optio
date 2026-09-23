package dev.optio.feature.insights

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.CallMerge
import androidx.compose.material.icons.outlined.AttachMoney
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Group
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.InsightCard
import dev.optio.core.ui.components.PeriodPicker
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.RateBar
import dev.optio.core.ui.components.SkeletonStrip
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.dimmedWhileLoading
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.theme.tabularNums
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Insights › Analytics (iOS `AnalyticsModel`): four analytics routes for one period. */
internal class AnalyticsViewModel(private val api: ApiClient) : ViewModel() {
    data class Data(
        val performance: PerformanceAnalytics,
        val agents: AgentAnalytics,
        val failures: FailureAnalytics,
        val prs: PrAnalytics,
    )

    private val _state = MutableStateFlow<LoadState<Data>>(LoadState.Idle)
    val state: StateFlow<LoadState<Data>> = _state.asStateFlow()

    private val _days = MutableStateFlow(30)
    val days: StateFlow<Int> = _days.asStateFlow()

    private var job: Job? = null

    fun refresh() {
        job?.cancel()
        job = viewModelScope.launch { fetch() }
    }

    suspend fun reload() {
        job?.cancel()
        fetch()
    }

    fun setDays(days: Int) {
        if (days == _days.value) return
        _days.value = days
        refresh()
    }

    private suspend fun fetch() {
        val d = _days.value
        _state.load {
            coroutineScope {
                val performance = async { api.performanceAnalytics(d) }
                val agents = async { api.agentAnalytics(d) }
                val failures = async { api.failureAnalytics(d) }
                val prs = async { api.prAnalytics(d) }
                Data(performance.await(), agents.await(), failures.await(), prs.await())
            }
        }
    }
}

/** Insights › Analytics (iOS `AnalyticsView`, web `/analytics`). */
@Composable
fun AnalyticsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val model = viewModel(key = "insights-analytics") { AnalyticsViewModel(api) }
    val state by model.state.collectAsStateWithLifecycle()
    val days by model.days.collectAsStateWithLifecycle()
    LaunchedEffect(model) { model.refresh() }
    AnalyticsContent(
        state = state,
        days = days,
        contentPadding = contentPadding,
        modifier = modifier,
        onDays = model::setDays,
        onRefresh = model::reload,
        onRetry = model::refresh,
    )
}

@Composable
internal fun AnalyticsContent(
    state: LoadState<AnalyticsViewModel.Data>,
    days: Int,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onDays: (Int) -> Unit = {},
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
) {
    val data = state.value
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("analytics")) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth().dimmedWhileLoading(state.isLoading && data != null),
            contentPadding = contentPadding,
            verticalArrangement = Arrangement.spacedBy(Spacing.l),
        ) {
            item(key = "period") { PeriodPicker(days = days, onDaysChange = onDays, contentPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.xs)) }
            when {
                data == null && state is LoadState.Failed -> item(key = "error") {
                    if (state.error.isForbidden) AdminOnlyState(what = "Analytics") else ErrorRow(error = state.error, what = "analytics", retry = onRetry)
                }
                data == null -> item(key = "skeleton") {
                    SkeletonStrip(labels = listOf("Success", "Avg duration", "Queue wait", "PR merge"), modifier = Modifier.padding(horizontal = Spacing.l))
                }
                else -> analyticsCards(data)
            }
            item(key = "bottom") { Column(Modifier.padding(bottom = Spacing.l)) {} }
        }
    }
}

private fun LazyListScope.analyticsCards(data: AnalyticsViewModel.Data) {
    item(key = "summary") { SummaryTiles(data) }
    val bars = data.performance.tasksPerDay.orEmpty().mapNotNull { p ->
        epochDay(p.date)?.let { DayBar(it, p.succeeded ?: 0, p.failed ?: 0) }
    }
    if (bars.isNotEmpty()) {
        item(key = "tasks-over-time") {
            SectionCard("Tasks over time") { TasksOverTimeChart(bars) }
        }
    }
    val agents = data.agents.agents.orEmpty()
    if (agents.isNotEmpty()) item(key = "agents") { AgentComparison(agents) }
    val failures = data.failures
    if (!failures.errorMessages.isNullOrEmpty()) item(key = "failures") { FailureBreakdown(failures) }
    val repos = failures.failureByRepo.orEmpty()
    if (repos.isNotEmpty()) {
        item(key = "failure-repo") {
            SectionCard("Failure rate by repo") {
                repos.take(8).forEach { r ->
                    val rate = r.failureRate ?: 0.0
                    RateBar(
                        label = InsightsFormat.repoShortName(r.repoUrl),
                        valueText = "${rate.toInt()}% (${r.failed ?: 0}/${r.total ?: 0})",
                        fraction = rate / 100,
                        color = rateColor(rate),
                    )
                }
            }
        }
    }
    val models = failures.failureByModel.orEmpty()
    if (models.isNotEmpty()) {
        item(key = "failure-model") {
            SectionCard("Failure rate by model") {
                models.forEach { m ->
                    val rate = m.failureRate ?: 0.0
                    RateBar(label = m.model, valueText = "${rate.toInt()}% (${m.failed ?: 0}/${m.total ?: 0})", fraction = rate / 100, color = rateColor(rate))
                }
            }
        }
    }
    val prs = data.prs
    val funnel = prs.funnel
    if ((prs.totalPrs ?: 0) > 0 && funnel != null) item(key = "funnel") { PrFunnelCard(prs, funnel) }
}

/** An [InsightCard] with the screen gutter. */
@Composable
internal fun SectionCard(
    title: String,
    icon: ImageVector? = null,
    content: @Composable () -> Unit,
) {
    InsightCard(title = title, icon = icon, modifier = Modifier.padding(horizontal = Spacing.l)) { content() }
}

@Composable
private fun rateColor(rate: Double) = if (rate >= 30) OptioTheme.colors.red else ChartPalette.color(1)

@Composable
private fun SummaryTiles(data: AnalyticsViewModel.Data) {
    val p = data.performance
    val prs = data.prs
    val trend = p.successRateTrend ?: 0.0
    Column(Modifier.padding(horizontal = Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        StatStrip(
            items = listOf(
                StatItem("Success", InsightsFormat.percent(p.successRate ?: 0.0)),
                StatItem("Avg duration", InsightsFormat.duration(p.durations?.avgExecution)),
                StatItem("Queue wait", InsightsFormat.duration(p.durations?.avgQueueWait)),
                StatItem("PR merge", InsightsFormat.percent(prs.autoMergeRate ?: 0.0)),
            ),
        )
        metaText(
            if (trend != 0.0) "${if (trend > 0) "+" else ""}${trend.toInt()}pp vs previous" else null,
            "p95 ${InsightsFormat.duration(p.durations?.p95Execution)}",
            "${p.durations?.taskCount ?: 0} completed",
            "${prs.merged ?: 0} of ${prs.totalPrs ?: 0} PRs merged",
        )?.let { Text(it, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.testTag("analytics-meta")) }
    }
}

@Composable
private fun AgentComparison(agents: List<AgentAnalyticsRow>) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    SectionCard("Agent comparison", icon = Icons.Outlined.Group) {
        Column {
            agents.forEachIndexed { index, a ->
                if (index > 0) InsetDivider(start = 0.dp)
                Column(Modifier.fillMaxWidth().padding(vertical = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                        Text(
                            (a.agentType ?: "?").replace('-', ' ').replaceFirstChar { it.titlecase(Locale.US) },
                            style = type.subheadline.medium(),
                            color = colors.label,
                            modifier = Modifier.weight(1f),
                        )
                        Text("${a.taskCount ?: 0} tasks", style = type.caption, color = colors.secondaryLabel)
                        val rate = a.successRate ?: 0.0
                        Text(
                            InsightsFormat.percent(rate),
                            style = type.caption.semibold().tabularNums(),
                            color = if (rate < 50) colors.red else colors.label,
                        )
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                        Fact(Icons.Outlined.Schedule, InsightsFormat.duration(a.avgDuration))
                        Fact(Icons.Outlined.AttachMoney, InsightsFormat.cost(a.avgCost))
                        Fact(Icons.Outlined.Replay, String.format(Locale.US, "%.1f retries", a.avgRetries ?: 0.0))
                    }
                    a.models?.takeIf { it.isNotEmpty() }?.let { models ->
                        Text(
                            models.joinToString(", ") { InsightsFormat.modelShortName(it.model) },
                            style = type.caption2,
                            color = colors.tertiaryLabel,
                        )
                    }
                }
            }
        }
    }
}

@Composable
internal fun Fact(icon: ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(13.dp))
        Text(text, style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel, maxLines = 1)
    }
}

/** Top error messages as bars with counts, then retry / stall rates (iOS `failureBreakdown`). */
@Composable
private fun FailureBreakdown(f: FailureAnalytics) {
    val top = f.errorMessages.orEmpty().sortedByDescending { it.count }.take(8)
    val max = top.maxOfOrNull { it.count }?.coerceAtLeast(1) ?: 1
    SectionCard("Failure breakdown", icon = Icons.Outlined.WarningAmber) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            top.forEach { m ->
                RateBar(label = shortMessage(m.message), valueText = "${m.count}", fraction = m.count.toDouble() / max)
            }
            InsetDivider(start = 0.dp)
            Row(horizontalArrangement = Arrangement.spacedBy(14.dp)) {
                LabeledRate(
                    icon = Icons.Outlined.Replay,
                    label = "Retry success ",
                    value = InsightsFormat.percent(f.retrySuccessRate ?: 0.0),
                    detail = " (${f.retrySucceededCount ?: 0}/${f.retriedCount ?: 0})",
                )
                val stalls = f.stallCount ?: 0
                if (stalls > 0) {
                    LabeledRate(
                        icon = Icons.Outlined.Bolt,
                        label = "Stalls ",
                        value = "$stalls",
                        detail = " (${InsightsFormat.percent(f.stallRecoveryRate ?: 0.0)} recovered)",
                    )
                }
            }
        }
    }
}

@Composable
private fun LabeledRate(icon: ImageVector, label: String, value: String, detail: String) {
    val colors = OptioTheme.colors
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
        Icon(icon, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(14.dp))
        Text(
            buildAnnotatedString {
                append(label)
                withStyle(SpanStyle(fontWeight = FontWeight.SemiBold)) { append(value) }
                withStyle(SpanStyle(color = colors.secondaryLabel)) { append(detail) }
            },
            style = OptioTheme.type.caption,
            color = colors.label,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}

/** At most 28 characters, like the iOS bar labels. */
internal fun shortMessage(message: String): String {
    val t = message.trim()
    return if (t.length > 28) t.take(27) + "…" else t
}

@Composable
private fun PrFunnelCard(prs: PrAnalytics, funnel: PrFunnel) {
    val opened = funnel.prOpened ?: 0
    val steps = listOf(
        "PR opened" to opened,
        "CI passed" to (funnel.ciPassed ?: 0),
        "Review approved" to (funnel.reviewApproved ?: 0),
        "Merged" to (funnel.merged ?: 0),
    )
    SectionCard("PR lifecycle funnel", icon = Icons.AutoMirrored.Outlined.CallMerge) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            steps.forEachIndexed { i, (label, count) ->
                val pct = if (opened > 0) count.toDouble() / opened else 0.0
                RateBar(
                    label = label,
                    valueText = if (i == 0) "$count" else "$count · ${Math.round(pct * 100)}%",
                    fraction = pct,
                    color = ChartPalette.color(i),
                )
            }
            InsetDivider(start = 0.dp)
            val colors = OptioTheme.colors
            Text(
                buildAnnotatedString {
                    fun part(label: String, value: String) {
                        append(label)
                        withStyle(SpanStyle(fontWeight = FontWeight.SemiBold, color = colors.label)) { append(value) }
                    }
                    part("CI pass ", InsightsFormat.percent(prs.ciPassRate ?: 0.0))
                    append("   ")
                    part("Review approval ", InsightsFormat.percent(prs.reviewApprovalRate ?: 0.0))
                    append("   ")
                    part("Avg merge ", InsightsFormat.duration(prs.avgMergeTime))
                },
                style = OptioTheme.type.caption,
                color = colors.secondaryLabel,
            )
        }
    }
}
