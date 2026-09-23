package dev.optio.feature.tasks.job

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.foundation.clickable
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
import androidx.compose.material.icons.automirrored.outlined.PlaylistPlay
import androidx.compose.material.icons.filled.PlayArrow
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.ExpandMore
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.rotate
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.JobFormRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.capitalizedFirst
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.tasks.common.CollectUiMessages
import dev.optio.feature.tasks.common.DetailScaffold
import dev.optio.feature.tasks.common.MenuAction
import dev.optio.feature.tasks.common.OverflowMenu
import dev.optio.feature.tasks.data.JobFormat
import dev.optio.feature.tasks.data.JobRun
import dev.optio.feature.tasks.data.JobSummary
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.task.AddRow
import dev.optio.feature.tasks.trigger.AddTriggerSheet
import dev.optio.feature.tasks.trigger.TriggerRowView
import java.time.Instant
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/** The job detail's segments. */
enum class JobSection(val label: String) { RUNS("Runs"), TRIGGERS("Triggers"), CONFIG("Config") }

/** `JobDetailRoute(id)`: a Job (iOS `JobDetailView`, web `/jobs/[id]`). */
@Composable
fun JobDetailScreen(jobId: String) {
    val api = LocalApiClient.current
    val vm: JobDetailViewModel = viewModel { JobDetailViewModel(api, jobId) }
    JobDetailScreen(vm, baseUrl = api.baseUrl?.toString())
}

@Composable
internal fun JobDetailScreen(vm: JobDetailViewModel, baseUrl: String?) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current
    val hasActiveRuns = state.value?.hasActiveRuns == true

    LaunchedEffect(vm) { vm.refresh() }
    // Web polls every 5 s while runs are active (iOS `.task(id: hasActiveRuns)`).
    LaunchedEffect(vm, hasActiveRuns) {
        if (!hasActiveRuns) return@LaunchedEffect
        while (true) {
            delay(5.seconds)
            vm.refresh()
        }
    }
    CollectUiMessages(vm.messages)

    var showRun by remember { mutableStateOf(false) }
    var showAddTrigger by remember { mutableStateOf(false) }

    JobDetailContent(
        state = state,
        busy = busy,
        baseUrl = baseUrl,
        actions = JobDetailActions(
            retryLoad = vm::load,
            refresh = vm::load,
            run = { showRun = true },
            edit = { navigator.push(JobFormRoute(vm.jobId)) },
            duplicate = vm::duplicate,
            toggleEnabled = vm::toggleEnabled,
            delete = vm::delete,
            openRun = { navigator.push(JobRunRoute(vm.jobId, it)) },
            setTriggerEnabled = vm::setTriggerEnabled,
            deleteTrigger = vm::deleteTrigger,
            addTrigger = { showAddTrigger = true },
        ),
    )

    val job = state.value?.job
    if (showRun && job != null) {
        RunJobSheet(job = job, onRun = { vm.runJob(it) }, onDismiss = { showRun = false })
    }
    if (showAddTrigger) {
        AddTriggerSheet(baseUrl = baseUrl, onAdd = vm::addTrigger, onDismiss = { showAddTrigger = false })
    }
}

/** What the job detail's controls do; defaults do nothing (screenshots). */
class JobDetailActions(
    val retryLoad: () -> Unit = {},
    val refresh: () -> Unit = {},
    val run: () -> Unit = {},
    val edit: () -> Unit = {},
    val duplicate: () -> Unit = {},
    val toggleEnabled: () -> Unit = {},
    val delete: () -> Unit = {},
    val openRun: (String) -> Unit = {},
    val setTriggerEnabled: (TriggerRow, Boolean) -> Unit = { _, _ -> },
    val deleteTrigger: (TriggerRow) -> Unit = {},
    val addTrigger: () -> Unit = {},
)

@Composable
fun JobDetailContent(
    state: LoadState<JobDetail>,
    busy: Boolean,
    baseUrl: String?,
    actions: JobDetailActions,
    modifier: Modifier = Modifier,
    initialSection: JobSection = JobSection.RUNS,
) {
    val detail = state.value
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    var section by rememberSaveable { mutableStateOf(initialSection) }
    var runFilter by rememberSaveable { mutableStateOf(RunFilter.ALL) }
    var showPrompt by rememberSaveable { mutableStateOf(false) }

    DetailScaffold(
        title = detail?.job?.name?.ifEmpty { null } ?: "Job",
        modifier = modifier.testTag("job-detail"),
        actions = {
            if (detail != null && canMutate) {
                IconButton(onClick = actions.run, enabled = detail.job.isEnabled && !busy, modifier = Modifier.testTag("run-job")) {
                    Icon(Icons.Filled.PlayArrow, contentDescription = "Run")
                }
            }
            if (detail != null) {
                OverflowMenu(
                    busy = busy,
                    items = buildList {
                        if (canMutate) {
                            add(MenuAction("Edit", Icons.Outlined.Edit, testTag = "action-edit", onClick = actions.edit))
                            add(MenuAction("Duplicate", Icons.Outlined.ContentCopy, testTag = "action-duplicate", onClick = actions.duplicate))
                            add(
                                if (detail.job.isEnabled) {
                                    MenuAction("Disable", Icons.Outlined.Pause, testTag = "action-disable", onClick = actions.toggleEnabled)
                                } else {
                                    MenuAction("Enable", Icons.Outlined.PlayArrow, testTag = "action-enable", onClick = actions.toggleEnabled)
                                },
                            )
                        }
                        add(MenuAction("Refresh", Icons.Outlined.Refresh, testTag = "action-refresh", onClick = actions.refresh))
                        if (canMutate) {
                            add(
                                MenuAction("Delete", Icons.Outlined.Delete, destructive = true, dividerBefore = true, testTag = "action-delete") {
                                    confirm.ask("Delete this job?", "Delete this job and all its runs? This cannot be undone.", "Delete Job", destructive = true, onConfirm = actions.delete)
                                },
                            )
                        }
                    },
                )
            }
        },
    ) { padding ->
        Loadable(state = state, onRetry = actions.retryLoad, onRefresh = actions.refresh, what = "job", modifier = Modifier.padding(padding)) { value ->
            LazyColumn(Modifier.fillMaxSize().readableWidth(), contentPadding = PaddingValues(bottom = Spacing.xl)) {
                item(key = "header") { JobHeader(value) }
                item(key = "tabs") {
                    DetailTabs(options = JobSection.entries.map { it to it.label }, selection = section, onSelect = { section = it })
                }
                when (section) {
                    JobSection.RUNS -> runsSection(value, runFilter, onFilter = { runFilter = it }, canMutate, actions)
                    JobSection.TRIGGERS -> triggersSection(value.triggers, baseUrl, canMutate, actions, confirm = { t ->
                        confirm.ask("Delete ${t.label.lowercase()} trigger?", null, "Delete", destructive = true) { actions.deleteTrigger(t) }
                    })
                    JobSection.CONFIG -> configSection(value.job, showPrompt, onTogglePrompt = { showPrompt = !showPrompt })
                }
            }
        }
    }
    ConfirmHost(confirm)
}

/** The header line (iOS `DetailHeader(line:)`), for tests. */
internal object JobHeaderText {
    fun state(detail: JobDetail): Pair<String, Tone> = when {
        !detail.job.isEnabled -> "paused" to Tone.IDLE
        detail.activeRunCount > 0 -> "running" to Tone.WORKING
        else -> "active" to Tone.IDLE
    }

    fun line(detail: JobDetail, now: Instant): AnnotatedString? = metaText(
        JobFormat.runtimeLabel(detail.job.runtime),
        detail.job.model?.takeIf { it.isNotEmpty() },
        detail.job.lastRunAt?.let { "last run ${it.relativeDescription(now)}" } ?: "no runs yet",
        if (detail.activeRunCount > 0) "${detail.activeRunCount} active" else null,
    )
}

@Composable
private fun JobHeader(detail: JobDetail) {
    val now = LocalClock.current.instant()
    val (state, tone) = JobHeaderText.state(detail)
    Column {
        DetailHeader(
            state = state,
            tone = tone,
            line = JobHeaderText.line(detail, now),
            secondary = detail.job.description?.takeIf { it.isNotEmpty() }?.let(::AnnotatedString),
        )
        StatStrip(
            items = listOf(
                StatItem("Runs", detail.job.runCount ?: detail.runs.size, key = "runs"),
                StatItem("Success", detail.successRateText, isZero = detail.runs.isEmpty(), key = "success"),
                StatItem("Cost", Cost.format(detail.job.totalCostUsd), isZero = Cost.formatIfNonZero(detail.job.totalCostUsd) == null, key = "cost"),
            ),
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
        )
    }
}

private fun LazyListScope.runsSection(
    detail: JobDetail,
    filter: RunFilter,
    onFilter: (RunFilter) -> Unit,
    canMutate: Boolean,
    actions: JobDetailActions,
) {
    if (detail.runs.isEmpty()) {
        item(key = "runs-empty") {
            EmptyState(
                title = "No runs yet",
                icon = Icons.AutoMirrored.Outlined.PlaylistPlay,
                message = "Start your first run to see results here.",
                actionTitle = if (canMutate && detail.job.isEnabled) "Run Now" else null,
                action = actions.run,
            )
        }
        return
    }
    item(key = "run-filter") {
        ChipPicker(
            options = listOf(
                RunFilter.ALL to "All",
                RunFilter.RUNNING to "Running ${detail.runs(RunFilter.RUNNING).size}",
                RunFilter.COMPLETED to "Completed ${detail.runs(RunFilter.COMPLETED).size}",
                RunFilter.FAILED to "Failed ${detail.runs(RunFilter.FAILED).size}",
            ),
            selection = filter,
            onSelect = onFilter,
        )
    }
    val runs = detail.runs(filter)
    item(key = "runs") {
        GroupedSection {
            if (runs.isEmpty()) {
                Text("No ${filter.word} runs", style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(Spacing.l))
            }
            runs.forEachIndexed { index, run ->
                if (index > 0) InsetDivider()
                JobRunRow(run, onClick = { actions.openRun(run.id) })
            }
        }
    }
}

private fun LazyListScope.triggersSection(
    triggers: List<TriggerRow>,
    baseUrl: String?,
    canMutate: Boolean,
    actions: JobDetailActions,
    confirm: (TriggerRow) -> Unit,
) {
    if (triggers.isEmpty()) {
        item(key = "triggers-empty") {
            EmptyState(
                title = "No triggers configured",
                icon = Icons.Outlined.Bolt,
                message = "Triggers define how this job is started (manually, on schedule, or via webhook).",
                actionTitle = if (canMutate) "Add trigger" else null,
                action = actions.addTrigger,
            )
        }
        return
    }
    item(key = "triggers") {
        GroupedSection {
            triggers.forEachIndexed { index, trigger ->
                if (index > 0) InsetDivider(start = 64.dp)
                TriggerRowView(
                    trigger = trigger,
                    baseUrl = baseUrl,
                    onToggle = if (canMutate) ({ on -> actions.setTriggerEnabled(trigger, on) }) else null,
                    onDelete = if (canMutate) ({ confirm(trigger) }) else null,
                )
            }
            if (canMutate) {
                InsetDivider()
                AddRow("Add trigger", onClick = actions.addTrigger, icon = Icons.Outlined.Bolt, modifier = Modifier.testTag("add-trigger"))
            }
        }
    }
}

private fun LazyListScope.configSection(job: JobSummary, showPrompt: Boolean, onTogglePrompt: () -> Unit) {
    item(key = "config") {
        val now = LocalClock.current.instant()
        GroupedSection(header = "Job Configuration") {
            val rows = listOf(
                "Agent Runtime" to JobFormat.runtimeLabel(job.runtime),
                "Model" to (job.model?.takeIf { it.isNotEmpty() } ?: "Default"),
                "Max Turns" to (job.maxTurns?.toString() ?: "Default"),
                "Budget" to (job.budgetUsd?.let { "$$it" } ?: "Unlimited"),
                "Max Concurrent" to "${job.maxConcurrent ?: 2}",
                "Max Retries" to "${job.maxRetries ?: 1}",
                "Warm Pool" to "${job.warmPoolSize ?: 0}",
                "Max Pod Instances" to "${job.maxPodInstances ?: 1}",
                "Max Agents Per Pod" to "${job.maxAgentsPerPod ?: 2}",
                "Created" to (job.createdAt?.relativeDescription(now) ?: "—"),
                "Updated" to (job.updatedAt?.relativeDescription(now) ?: "—"),
            )
            rows.forEachIndexed { index, (label, value) ->
                if (index > 0) InsetDivider()
                KeyValueRow(label, value)
            }
        }
    }
    prettyJson(job.paramsSchema)?.let { schema ->
        item(key = "schema") {
            GroupedSection(header = "Parameter Schema") {
                CodeBlock(schema, modifier = Modifier.padding(Spacing.m), background = OptioTheme.colors.fillQuaternary)
            }
        }
    }
    item(key = "prompt") {
        GroupedSection {
            Row(
                Modifier.fillMaxWidth().clickable(onClick = onTogglePrompt).padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("prompt-template-toggle"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Prompt Template", style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
                Icon(
                    Icons.Outlined.ExpandMore,
                    contentDescription = if (showPrompt) "Collapse" else "Expand",
                    tint = OptioTheme.colors.tertiaryLabel,
                    modifier = Modifier.size(20.dp).rotate(if (showPrompt) 180f else 0f),
                )
            }
            AnimatedVisibility(showPrompt) {
                CodeBlock(job.promptTemplate.orEmpty(), modifier = Modifier.padding(start = Spacing.m, end = Spacing.m, bottom = Spacing.m))
            }
        }
    }
}

/** A run in the job's list (iOS `JobRunRow`): state, duration · model · cost · tokens, the error. */
@Composable
fun JobRunRow(run: JobRun, modifier: Modifier = Modifier, onClick: (() -> Unit)? = null) {
    val now = LocalClock.current.instant()
    val stateLabel = run.state.replace('_', ' ').capitalizedFirst()
    OptioRow(
        title = run.title?.takeIf { it.isNotBlank() } ?: stateLabel,
        modifier = modifier.testTag("run-row-${run.id}"),
        tone = Tone.forState(run.state),
        meta = metaText(
            if (!run.title.isNullOrBlank()) stateLabel else null,
            run.durationText(now),
            run.modelUsed?.let(InsightsFormat::modelShortName),
            run.costText,
            run.tokensText,
        ),
        trailing = (run.startedAt ?: run.createdAt)?.relativeDescription(now),
        footer = run.errorMessage?.takeIf { it.isNotEmpty() }?.let(::AnnotatedString),
        footerTone = Tone.DANGER,
        onClick = onClick,
    )
}

/** Pretty-printed JSON (iOS `JobFormat.prettyJSON`); null when empty. */
internal fun prettyJson(map: Map<String, JsonElement>?): String? {
    if (map.isNullOrEmpty()) return null
    return PrettyJson.encodeToString(JsonElement.serializer(), JsonObject(map).sortedKeys())
}

/** Keys sorted at every level (iOS `.sortedKeys`). */
private fun JsonElement.sortedKeys(): JsonElement = when (this) {
    is JsonObject -> JsonObject(toSortedMap().mapValues { it.value.sortedKeys() })
    is kotlinx.serialization.json.JsonArray -> kotlinx.serialization.json.JsonArray(map { it.sortedKeys() })
    else -> this
}

@OptIn(kotlinx.serialization.ExperimentalSerializationApi::class)
private val PrettyJson = kotlinx.serialization.json.Json(OptioJson) {
    prettyPrint = true
    prettyPrintIndent = "  "
}
