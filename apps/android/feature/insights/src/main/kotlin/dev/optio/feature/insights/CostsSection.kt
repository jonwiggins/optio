package dev.optio.feature.insights

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Lightbulb
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
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
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.NoticeBanner
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
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.ChartPalette
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.tabularNums
import java.time.Instant
import java.util.Locale
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch

/** Insights › Costs (iOS `CostsModel`): one period, optionally one repo. */
internal class CostsViewModel(private val api: ApiClient) : ViewModel() {
    data class Filter(val days: Int = 30, val repoUrl: String? = null)

    private val _state = MutableStateFlow<LoadState<CostAnalytics>>(LoadState.Idle)
    val state: StateFlow<LoadState<CostAnalytics>> = _state.asStateFlow()

    private val _filter = MutableStateFlow(Filter())
    val filter: StateFlow<Filter> = _filter.asStateFlow()

    private val _shown = MutableStateFlow<Filter?>(null)

    /**
     * The filter the costs on screen were loaded with: a failed reload (a new repo filter) keeps
     * the earlier numbers up, and they must not be labelled with the new repo.
     */
    val shown: StateFlow<Filter?> = _shown.asStateFlow()

    /** (url, name) of the workspace's repos for the filter menu. */
    private val _repos = MutableStateFlow<List<Pair<String, String>>>(emptyList())
    val repos: StateFlow<List<Pair<String, String>>> = _repos.asStateFlow()

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
        if (days == _filter.value.days) return
        _filter.value = _filter.value.copy(days = days)
        refresh()
    }

    fun setRepo(url: String?) {
        if (url == _filter.value.repoUrl) return
        _filter.value = _filter.value.copy(repoUrl = url)
        refresh()
    }

    private suspend fun fetch() {
        val f = _filter.value
        if (_state.load { api.costAnalytics(f.days, f.repoUrl) } != null) _shown.value = f
        if (_repos.value.isEmpty()) runCatching { api.repoUrls() }.onSuccess { _repos.value = it }
    }
}

/** Insights › Costs (iOS `CostsView`, web `/costs`). */
@Composable
fun CostsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val model = viewModel(key = "insights-costs") { CostsViewModel(api) }
    val state by model.state.collectAsStateWithLifecycle()
    val filter by model.filter.collectAsStateWithLifecycle()
    val shown by model.shown.collectAsStateWithLifecycle()
    val repos by model.repos.collectAsStateWithLifecycle()
    LaunchedEffect(model) { model.refresh() }
    HubActions { CostsRepoFilter(repos = repos, selection = filter.repoUrl, onSelect = model::setRepo) }
    CostsContent(
        state = state,
        filter = filter,
        shownFilter = shown,
        contentPadding = contentPadding,
        modifier = modifier,
        onDays = model::setDays,
        onRefresh = model::reload,
        onRetry = model::refresh,
        onOpen = navigator::push,
    )
}

@Composable
private fun CostsRepoFilter(
    repos: List<Pair<String, String>>,
    selection: String?,
    onSelect: (String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("costs-repo-filter")) {
            Icon(
                Icons.Outlined.FilterList,
                contentDescription = "Filter by repo",
                tint = if (selection == null) LocalContentColor.current else OptioTheme.colors.accent,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            MenuChoice("All repos", selection == null) {
                open = false
                onSelect(null)
            }
            repos.forEach { (url, name) ->
                MenuChoice(name, selection == url) {
                    open = false
                    onSelect(url)
                }
            }
        }
    }
}

/** A single-choice menu row with a check on the current value. */
@Composable
internal fun MenuChoice(label: String, selected: Boolean, onClick: () -> Unit) {
    DropdownMenuItem(
        text = { Text(label) },
        trailingIcon = if (selected) ({ Icon(Icons.Filled.Check, contentDescription = "Selected") }) else null,
        onClick = onClick,
    )
}

@Composable
internal fun CostsContent(
    state: LoadState<CostAnalytics>,
    filter: CostsViewModel.Filter,
    contentPadding: PaddingValues,
    // What the numbers on screen were loaded with (null: [filter]).
    shownFilter: CostsViewModel.Filter? = null,
    modifier: Modifier = Modifier,
    onDays: (Int) -> Unit = {},
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onOpen: (NavKey) -> Unit = {},
) {
    val previous = state.value
    // A failed refresh of the same period and repo keeps the last numbers up (flagged). Numbers
    // for another period or repo (the filter just changed and its load failed) would read as the
    // new filter's, e.g. all repos under an active repo filter, so then only the error shows.
    val otherQuery = state is LoadState.Failed && shownFilter != null && shownFilter != filter
    val data = previous.takeUnless { otherQuery }
    val now = rememberNow()
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("costs")) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth().dimmedWhileLoading(state.isLoading && previous != null),
            contentPadding = contentPadding,
            verticalArrangement = Arrangement.spacedBy(Spacing.l),
        ) {
            item(key = "period") { PeriodPicker(days = filter.days, onDaysChange = onDays, contentPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.xs)) }
            // A failed refresh keeps the last numbers on screen: say they're stale.
            if (data != null && state is LoadState.Failed) {
                item(key = "stale") { ErrorRow(error = state.error, what = "costs", retry = onRetry) }
            }
            when {
                data == null && state is LoadState.Failed -> item(key = "error") {
                    if (state.error.isForbidden) AdminOnlyState(what = "Cost analytics") else ErrorRow(error = state.error, what = "costs", retry = onRetry)
                }
                data == null -> item(key = "skeleton") {
                    SkeletonStrip(labels = listOf("Total", "Average", "Forecast", "Previous"), modifier = Modifier.padding(horizontal = Spacing.l))
                }
                else -> costCards(data, shownFilter ?: filter, now, onOpen)
            }
            item(key = "bottom") { Box(Modifier.padding(bottom = Spacing.s)) }
        }
    }
}

private fun LazyListScope.costCards(
    d: CostAnalytics,
    filter: CostsViewModel.Filter,
    now: Instant,
    onOpen: (NavKey) -> Unit,
) {
    item(key = "summary") { CostSummaryTiles(d, filter) }
    d.modelSuggestions?.takeIf { it.isNotEmpty() }?.let { s -> item(key = "suggestions") { Suggestions(s) } }
    d.anomalies?.takeIf { it.isNotEmpty() }?.let { a -> item(key = "anomalies") { Anomalies(a) } }
    item(key = "over-time") {
        val points = d.dailyCosts.orEmpty().mapNotNull { p -> epochDay(p.date)?.let { DayCost(it, p.cost ?: 0.0) } }
        SectionCard("Cost over time") {
            if (points.isEmpty()) {
                Box(Modifier.fillMaxWidth().heightIn(min = 120.dp), contentAlignment = Alignment.Center) {
                    Text("No cost data for this period", style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
                }
            } else {
                CostOverTimeChart(points)
            }
        }
    }
    d.costByModel?.takeIf { it.isNotEmpty() }?.let { models -> item(key = "by-model") { ByModel(models) } }
    d.costByRepo?.takeIf { it.isNotEmpty() }?.let { repos ->
        item(key = "by-repo") {
            val max = repos.maxOf { it.totalCost ?: 0.0 }.coerceAtLeast(0.0001)
            SectionCard("Cost by repository") {
                Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    repos.forEach { r ->
                        RateBar(
                            label = InsightsFormat.repoShortName(r.repoUrl),
                            valueText = "${InsightsFormat.cost(r.totalCost)} (${r.taskCount ?: 0})",
                            fraction = (r.totalCost ?: 0.0) / max,
                        )
                    }
                }
            }
        }
    }
    d.costByType?.takeIf { it.isNotEmpty() }?.let { types -> item(key = "by-type") { ByType(types) } }
    item(key = "top") { TopTasks(d, now, onOpen) }
}

@Composable
private fun CostSummaryTiles(d: CostAnalytics, filter: CostsViewModel.Filter) {
    val s = d.summary
    val f = d.forecast
    val trend = s?.costTrend?.toDoubleOrNull() ?: 0.0
    Column(Modifier.padding(horizontal = Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        StatStrip(
            items = listOf(
                StatItem("Total", InsightsFormat.cost(s?.totalCost)),
                StatItem("Average", InsightsFormat.cost(s?.avgCost)),
                StatItem("Forecast", InsightsFormat.cost(f?.forecastedMonthTotal)),
                StatItem("Previous", InsightsFormat.cost(s?.prevPeriodCost)),
            ),
        )
        metaText(
            if (trend != 0.0) String.format(Locale.US, "%s%.1f%% vs previous %dd", if (trend > 0) "+" else "", trend, s?.days ?: filter.days) else null,
            counted(s?.tasksWithCost ?: 0, "task"),
            "${InsightsFormat.cost(f?.monthCostSoFar)} this month · ${f?.daysRemaining ?: 0}d left",
            filter.repoUrl?.let(InsightsFormat::repoShortName),
        )?.let { Text(it, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel) }
    }
}

@Composable
private fun Suggestions(suggestions: List<ModelSuggestion>) {
    NoticeBanner(
        tone = Tone.WORKING,
        icon = Icons.Outlined.Lightbulb,
        title = "Cost optimisation suggestions",
        modifier = Modifier.padding(horizontal = Spacing.l),
    ) {
        suggestions.forEach { x ->
            val avg = x.avgCost ?: 0.0
            val cheaper = x.cheaperModelAvgCost ?: 0.0
            val savings = avg - cheaper
            val pct = if (avg > 0) savings / avg * 100 else 0.0
            Text(
                "${InsightsFormat.repoShortName(x.repoUrl)}: ${counted(x.taskCount ?: 0, "task")} ran with ${InsightsFormat.modelShortName(x.currentModel)} " +
                    "(avg ${InsightsFormat.cost(avg)}). " +
                    if (cheaper > 0) "Try Sonnet to save ~${pct.toInt()}% (${InsightsFormat.cost(savings)}/task)." else "Consider trying Sonnet for potential savings.",
            )
        }
    }
}

@Composable
private fun Anomalies(anomalies: List<CostAnomaly>) {
    val colors = OptioTheme.colors
    NoticeBanner(
        tone = Tone.DANGER,
        icon = Icons.Outlined.WarningAmber,
        title = "Cost anomalies (${anomalies.size})",
        modifier = Modifier.padding(horizontal = Spacing.l),
    ) {
        Text("These tasks cost 3x or more than the repository average:")
        anomalies.take(5).forEach { x ->
            Text(
                buildAnnotatedString {
                    append(x.title ?: x.id)
                    append("  ")
                    withStyle(SpanStyle(color = colors.label, fontWeight = FontWeight.Medium)) { append(InsightsFormat.cost(x.costUsd)) }
                    append(String.format(Locale.US, " (%.1fx avg of %s)", x.costRatio ?: 0.0, InsightsFormat.cost(x.repoAvgCost)))
                },
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (anomalies.size > 5) Text("+${anomalies.size - 5} more anomalies")
    }
}

@Composable
private fun ByModel(models: List<CostByModel>) {
    val max = models.maxOf { it.totalCost ?: 0.0 }.coerceAtLeast(0.0001)
    val colors = OptioTheme.colors
    SectionCard("Cost by model", icon = Icons.Outlined.Memory) {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            models.forEach { m ->
                Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                    RateBar(label = InsightsFormat.modelShortName(m.model), valueText = InsightsFormat.cost(m.totalCost), fraction = (m.totalCost ?: 0.0) / max)
                    Row {
                        Text(
                            "${counted(m.taskCount ?: 0, "task")} · ${(m.successRate ?: 0.0).toInt()}% success",
                            style = OptioTheme.type.caption2,
                            color = colors.tertiaryLabel,
                            modifier = Modifier.weight(1f),
                        )
                        Text("avg ${InsightsFormat.cost(m.avgCost)}", style = OptioTheme.type.caption2, color = colors.tertiaryLabel)
                    }
                }
            }
        }
    }
}

@Composable
private fun ByType(types: List<CostByType>) {
    val total = types.sumOf { it.totalCost ?: 0.0 }
    val palette = ChartPalette.series
    val colors = OptioTheme.colors
    SectionCard("Cost by task type") {
        Column(verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
            ShareBar(types.map { it.totalCost ?: 0.0 })
            types.forEachIndexed { i, t ->
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    Box(Modifier.size(8.dp).clip(CircleShape).background(palette[i.mod(palette.size)]))
                    Text(t.taskType, style = OptioTheme.type.caption, color = colors.label, modifier = Modifier.weight(1f))
                    Text("${InsightsFormat.cost(t.totalCost)} (${t.taskCount ?: 0})", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                    Text(
                        if (total > 0) "${Math.round((t.totalCost ?: 0.0) / total * 100)}%" else "",
                        style = OptioTheme.type.caption.tabularNums(),
                        color = colors.tertiaryLabel,
                    )
                }
            }
        }
    }
}

/** Where a costly row opens: coding / review tasks and Local sessions have screens. */
internal fun TopCostTask.route(): NavKey? = when (taskType) {
    "coding", "review", null -> TaskDetailRoute(id)
    "local-session" -> LocalTerminalRoute(id)
    else -> null
}

@Composable
private fun TopTasks(d: CostAnalytics, now: Instant, onOpen: (NavKey) -> Unit) {
    val tasks = d.topTasks.orEmpty()
    val anomalyIds = d.anomalies.orEmpty().map { it.id }.toSet()
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    SectionCard("Most expensive tasks") {
        if (tasks.isEmpty()) {
            Text("No tasks with cost data", style = type.caption, color = colors.secondaryLabel)
            return@SectionCard
        }
        Column {
            tasks.forEachIndexed { index, t ->
                if (index > 0) InsetDivider(start = 0.dp)
                val route = t.route()
                Column(
                    Modifier
                        .fillMaxWidth()
                        .then(if (route != null) Modifier.clickable { onOpen(route) } else Modifier)
                        .padding(vertical = 6.dp)
                        .testTag("top-task-${t.id}"),
                    verticalArrangement = Arrangement.spacedBy(Spacing.xs),
                ) {
                    Row(verticalAlignment = Alignment.Top, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        if (t.id in anomalyIds) {
                            Icon(Icons.Outlined.WarningAmber, contentDescription = "Anomaly", tint = colors.red, modifier = Modifier.size(14.dp).padding(top = 2.dp))
                        }
                        Text(t.title ?: t.id, style = type.subheadline, color = colors.label, maxLines = 2, overflow = TextOverflow.Ellipsis, modifier = Modifier.weight(1f))
                        Text(InsightsFormat.cost(t.costUsd), style = type.subheadline.tabularNums(), fontWeight = FontWeight.SemiBold, color = colors.label)
                    }
                    Row(horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                        Text(
                            listOfNotNull(
                                t.repoUrl?.let(InsightsFormat::repoShortName),
                                InsightsFormat.modelShortName(t.modelUsed),
                                t.taskType,
                                t.state,
                            ).joinToString(" · "),
                            style = type.caption2,
                            color = colors.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.weight(1f),
                        )
                        if ((t.inputTokens ?: 0.0) > 0 || (t.outputTokens ?: 0.0) > 0) {
                            Text(
                                "${InsightsFormat.tokens(t.inputTokens)} / ${InsightsFormat.tokens(t.outputTokens)}",
                                style = type.caption2.tabularNums(),
                                color = colors.secondaryLabel,
                            )
                        }
                        InsightsDates.parse(t.createdAt)?.let {
                            Text(it.relativeDescription(now), style = type.caption2, color = colors.secondaryLabel, maxLines = 1)
                        }
                    }
                }
            }
        }
    }
}
