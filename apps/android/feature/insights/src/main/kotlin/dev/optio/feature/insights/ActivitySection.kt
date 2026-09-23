package dev.optio.feature.insights

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ChevronRight
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.History
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import androidx.navigation3.runtime.NavKey
import dev.optio.core.model.ActivityNewEvent
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.network.on
import dev.optio.core.ui.components.AdminOnlyState
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.NumericText
import dev.optio.core.ui.components.PeriodPicker
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.dimmedWhileLoading
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.RelativeTime
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.state.load
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import java.time.Instant
import java.time.ZoneId
import java.util.UUID
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject

/**
 * Insights › Activity (iOS `ActivityModel`): one page of `/api/activity` for a period and filters,
 * plus live `activity:new` frames from `/ws/events` prepended while the section is on screen (and
 * replaced by the real rows on a reload two seconds later).
 */
internal class ActivityViewModel(
    private val api: ApiClient,
    private val liveEvents: Flow<ActivityNewEvent>,
    /** Whether the events socket is open (the "live" badge). */
    val liveConnected: StateFlow<Boolean>,
    private val reconcileDelay: Duration = 2.seconds,
) : ViewModel() {
    data class Filter(
        val days: Int = 7,
        val type: String? = null,
        val resource: String? = null,
        val offset: Int = 0,
    )

    data class Page(
        val items: List<ActivityItem>,
        val total: Int,
        val stats: ActivityStats,
    )

    private val _state = MutableStateFlow<LoadState<Page>>(LoadState.Idle)
    val state: StateFlow<LoadState<Page>> = _state.asStateFlow()

    private val _filter = MutableStateFlow(Filter())
    val filter: StateFlow<Filter> = _filter.asStateFlow()

    private var loadJob: Job? = null
    private var liveJob: Job? = null
    private var reconcileJob: Job? = null

    fun refresh() {
        loadJob?.cancel()
        loadJob = viewModelScope.launch { fetch() }
    }

    suspend fun reload() {
        loadJob?.cancel()
        fetch()
    }

    private suspend fun fetch() {
        val f = _filter.value
        _state.load {
            val feed = api.activityFeed(days = f.days, type = f.type, resourceType = f.resource, limit = LIMIT, offset = f.offset)
            Page(feed.items, feed.total, feed.stats ?: ActivityStats())
        }
    }

    private fun setFilter(change: (Filter) -> Filter) {
        val next = change(_filter.value)
        if (next == _filter.value) return
        _filter.value = next
        refresh()
    }

    fun setDays(days: Int) = setFilter { it.copy(days = days, offset = 0) }

    fun setType(type: String?) = setFilter { it.copy(type = type, offset = 0) }

    fun setResource(resource: String?) = setFilter { it.copy(resource = resource, offset = 0) }

    fun nextPage() = setFilter { it.copy(offset = it.offset + LIMIT) }

    fun previousPage() = setFilter { it.copy(offset = maxOf(0, it.offset - LIMIT)) }

    /** Starts prepending live frames (the section is on screen). */
    fun startLive() {
        if (liveJob != null) return
        liveJob = viewModelScope.launch { liveEvents.collect(::prepend) }
    }

    fun stopLive() {
        liveJob?.cancel()
        liveJob = null
        reconcileJob?.cancel()
        reconcileJob = null
    }

    /** iOS `prepend`: only user actions are published, so only an unfiltered first page takes them. */
    internal fun prepend(event: ActivityNewEvent) {
        val f = _filter.value
        if (f.offset != 0 || (f.type != null && f.type != "action")) return
        if (f.resource != null && f.resource != event.resourceType) return
        val item = ActivityItem(
            id = "live-${UUID.randomUUID()}",
            type = "action",
            timestamp = event.timestamp,
            action = event.action,
            resourceType = event.resourceType ?: event.action.substringBefore('.'),
            resourceId = event.resourceId,
            summary = event.summary,
            isLive = true,
        )
        _state.update { state ->
            val page = state.value ?: Page(emptyList(), 0, ActivityStats())
            val next = page.copy(
                items = listOf(item) + page.items,
                total = page.total + 1,
                stats = page.stats.copy(actions = page.stats.actions + 1),
            )
            when (state) {
                is LoadState.Loading -> LoadState.Loading(next)
                is LoadState.Failed -> LoadState.Failed(state.error, next)
                else -> LoadState.Loaded(next)
            }
        }
        reconcileJob?.cancel()
        reconcileJob = viewModelScope.launch {
            delay(reconcileDelay)
            fetch()
        }
    }

    companion object {
        const val LIMIT = 50
    }
}

private val typeOptions: List<Pair<String?, String>> = listOf(
    null to "All types",
    "action" to "User actions",
    "task_event" to "Task events",
    "auth_event" to "Auth events",
    "infra_event" to "Infra events",
)

private val resourceOptions: List<Pair<String?, String>> = listOf(
    null to "All resources",
    "task" to "Tasks",
    "repo" to "Repos",
    "workflow" to "Workflows",
    "connection" to "Connections",
    "secret" to "Secrets",
    "webhook" to "Webhooks",
    "session" to "Sessions",
)

/** Insights › Activity (iOS `ActivityView`, web `/activity`). */
@Composable
fun ActivitySection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val navigator = LocalNavigator.current
    val model = viewModel(key = "insights-activity") { ActivityViewModel(api, hub.on<ActivityNewEvent>(), hub.connected) }
    val state by model.state.collectAsStateWithLifecycle()
    val filter by model.filter.collectAsStateWithLifecycle()
    val live by model.liveConnected.collectAsStateWithLifecycle()
    LaunchedEffect(model) { model.refresh() }
    LifecycleStartEffect(model) {
        model.startLive()
        onStopOrDispose { model.stopLive() }
    }
    HubActions { ActivityFilterMenu(filter, onType = model::setType, onResource = model::setResource) }
    ActivityContent(
        state = state,
        filter = filter,
        live = live,
        contentPadding = contentPadding,
        modifier = modifier,
        onDays = model::setDays,
        onRefresh = model::reload,
        onRetry = model::refresh,
        onNext = model::nextPage,
        onPrevious = model::previousPage,
        onOpen = navigator::push,
    )
}

@Composable
private fun ActivityFilterMenu(
    filter: ActivityViewModel.Filter,
    onType: (String?) -> Unit,
    onResource: (String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val filtered = filter.type != null || filter.resource != null
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("activity-filter")) {
            Icon(
                Icons.Outlined.FilterList,
                contentDescription = "Filter activity",
                tint = if (filtered) OptioTheme.colors.accent else LocalContentColor.current,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            MenuHeader("Type")
            typeOptions.forEach { (value, label) ->
                MenuChoice(label, filter.type == value) {
                    open = false
                    onType(value)
                }
            }
            HorizontalDivider()
            MenuHeader("Resource")
            resourceOptions.forEach { (value, label) ->
                MenuChoice(label, filter.resource == value) {
                    open = false
                    onResource(value)
                }
            }
        }
    }
}

@Composable
private fun MenuHeader(title: String) {
    Text(
        title,
        style = OptioTheme.type.footnote,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
    )
}

@Composable
internal fun ActivityContent(
    state: LoadState<ActivityViewModel.Page>,
    filter: ActivityViewModel.Filter,
    live: Boolean,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onDays: (Int) -> Unit = {},
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onNext: () -> Unit = {},
    onPrevious: () -> Unit = {},
    onOpen: (NavKey) -> Unit = {},
) {
    val page = state.value
    val now = rememberNow()
    val zone = LocalClock.current.zone
    val colors = OptioTheme.colors
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("activity")) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth().dimmedWhileLoading(state.isLoading && page != null && page.items.isNotEmpty()),
            contentPadding = contentPadding,
        ) {
            item(key = "period") {
                PeriodPicker(
                    days = filter.days,
                    onDaysChange = onDays,
                    options = listOf(1, 7, 14, 30),
                    contentPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.xs),
                )
            }
            item(key = "stats") {
                val stats = page?.stats ?: ActivityStats()
                StatStrip(
                    items = listOf(
                        StatItem("Actions", stats.actions),
                        StatItem("Task events", stats.taskEvents),
                        StatItem("Auth", stats.authEvents),
                        StatItem("Infra", stats.infraEvents),
                    ),
                    modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
                )
            }
            item(key = "count") {
                val total = page?.total ?: 0
                Row(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.xs), verticalAlignment = Alignment.CenterVertically) {
                    NumericText(
                        "$total event${if (total == 1) "" else "s"} in the last ${filter.days} day${if (filter.days == 1) "" else "s"}",
                        style = OptioTheme.type.caption,
                        color = colors.secondaryLabel,
                        modifier = Modifier.weight(1f),
                    )
                    if (live) {
                        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.testTag("activity-live")) {
                            StateDot(Tone.WORKING, size = 5.dp)
                            Text("live", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                        }
                    }
                }
            }
            when {
                (page == null || page.items.isEmpty()) && state is LoadState.Failed -> item(key = "error") {
                    if (state.error.isForbidden) AdminOnlyState(what = "The activity feed") else ErrorRow(error = state.error, what = "activity", retry = onRetry)
                }
                page == null -> item(key = "skeleton") { SkeletonRows() }
                page.items.isEmpty() -> item(key = "empty") {
                    EmptyState(title = "No activity", icon = Icons.Outlined.History, message = "Nothing matched these filters.")
                }
                else -> {
                    groupByDay(page.items, now, zone).forEach { (day, items) ->
                        item(key = "day-$day") { SectionHeader(day) }
                        items(items, key = { it.id }) { item ->
                            ActivityRow(item = item, now = now, onOpen = item.route()?.let { route -> { onOpen(route) } })
                            InsetDivider()
                        }
                    }
                    if (filter.offset > 0 || filter.offset + ActivityViewModel.LIMIT < page.total) {
                        item(key = "pager") { Pager(filter.offset, page.total, onPrevious, onNext) }
                    }
                }
            }
        }
    }
}

/** Items grouped under "Today" / "Yesterday" / "Sep 15", newest first (iOS `groupedByDay`). */
internal fun groupByDay(items: List<ActivityItem>, now: Instant, zone: ZoneId): List<Pair<String, List<ActivityItem>>> {
    val groups = LinkedHashMap<String, MutableList<ActivityItem>>()
    items.forEach { item ->
        val day = InsightsDates.parse(item.timestamp)?.let { RelativeTime.dayHeader(it, now, zone) } ?: "Unknown date"
        groups.getOrPut(day) { mutableListOf() } += item
    }
    return groups.map { (day, list) -> day to list }
}

/** A task row opens the task (the id of a task event is always a task's). */
internal fun ActivityItem.route(): NavKey? =
    resourceId?.takeIf { resourceType == "task" }?.let { TaskDetailRoute(it) }

private val prettyJson = Json {
    prettyPrint = true
    prettyPrintIndent = "  "
}

/** Details as sorted, indented JSON (iOS `.prettyPrinted, .sortedKeys`). */
internal fun prettyDetails(details: Map<String, kotlinx.serialization.json.JsonElement>): String =
    prettyJson.encodeToString(JsonObject.serializer(), JsonObject(details.toSortedMap()))

/** `actor summary` / `2h · task · task 1a2b3c4d`, details behind a disclosure (iOS `ActivityRow`). */
@Composable
private fun ActivityRow(
    item: ActivityItem,
    now: Instant,
    onOpen: (() -> Unit)?,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    var expanded by rememberSaveable(item.id) { mutableStateOf(false) }
    val tone = when (item.type) {
        "action" -> if (item.isLive) Tone.ACCENT else Tone.WORKING
        "infra_event" -> Tone.DANGER
        else -> null
    }
    val typeLabel = when (item.type) {
        "action" -> "action"
        "task_event" -> "task"
        "auth_event" -> "auth"
        "infra_event" -> "infra"
        else -> item.type
    }
    Column(
        Modifier
            .fillMaxWidth()
            .then(if (onOpen != null) Modifier.clickable(onClick = onOpen) else Modifier)
            .padding(horizontal = Spacing.l, vertical = Spacing.m)
            .testTag("activity-row-${item.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            if (tone != null) StateDot(tone, modifier = Modifier.padding(top = 8.dp))
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                val actor = item.actor?.displayName
                Text(
                    buildAnnotatedString {
                        if (actor != null) {
                            append(actor)
                            append(" ")
                            withStyle(SpanStyle(color = colors.secondaryLabel)) { append(item.summary) }
                        } else {
                            append(item.summary)
                        }
                    },
                    style = type.body,
                    color = colors.label,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
                metaText(
                    InsightsDates.parse(item.timestamp)?.relativeDescription(now) ?: item.timestamp,
                    typeLabel,
                    if (item.isLive) "new" else null,
                    item.resourceId?.takeIf { item.resourceType in setOf("task", "workflow", "session") }?.let { mono("${item.resourceType} ${it.take(8)}") },
                )?.let { Text(it, style = type.subheadline, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis) }
            }
        }
        val details = item.details
        if (!details.isNullOrEmpty()) {
            Row(
                Modifier
                    .padding(start = if (tone == null) 0.dp else 15.dp)
                    .clickable { expanded = !expanded }
                    .padding(vertical = 2.dp)
                    .testTag("activity-details"),
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(2.dp),
            ) {
                Icon(
                    if (expanded) Icons.Filled.ExpandMore else Icons.Filled.ChevronRight,
                    contentDescription = null,
                    tint = colors.secondaryLabel,
                    modifier = Modifier.size(16.dp),
                )
                Text("Details", style = type.footnote, color = colors.secondaryLabel)
            }
            AnimatedVisibility(expanded) {
                CodeBlock(prettyDetails(details), style = type.monoCaption, color = colors.secondaryLabel)
            }
        }
    }
}

@Composable
private fun Pager(offset: Int, total: Int, onPrevious: () -> Unit, onNext: () -> Unit) {
    Row(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.s, vertical = Spacing.s).testTag("activity-pager"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        TextButton(onClick = onPrevious, enabled = offset > 0) { Text("Previous") }
        Text(
            "${offset + 1}–${minOf(offset + ActivityViewModel.LIMIT, total)} of $total",
            style = OptioTheme.type.caption,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.weight(1f),
            textAlign = androidx.compose.ui.text.style.TextAlign.Center,
        )
        TextButton(onClick = onNext, enabled = offset + ActivityViewModel.LIMIT < total) { Text("Next") }
    }
}
