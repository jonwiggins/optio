package dev.optio.feature.tasks.scheduled

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Tune
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.ScheduledFormRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.tasks.common.CollectUiMessages
import dev.optio.feature.tasks.common.DetailScaffold
import dev.optio.feature.tasks.common.MenuAction
import dev.optio.feature.tasks.common.OverflowMenu
import dev.optio.feature.tasks.data.RunFormatting
import dev.optio.feature.tasks.data.ScheduleFormat
import dev.optio.feature.tasks.data.TaskConfigRow
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.task.AddRow
import dev.optio.feature.tasks.task.TaskRowView
import dev.optio.feature.tasks.trigger.AddTriggerSheet
import dev.optio.feature.tasks.trigger.TriggerRowView

/** The scheduled page's segments (iOS: config · triggers · runs). */
enum class ScheduledSection(val label: String) { CONFIG("Config"), TRIGGERS("Triggers"), RUNS("Runs") }

/** `ScheduledDetailRoute(id)`: a scheduled Task blueprint (iOS `ScheduledDetailView`). */
@Composable
fun ScheduledDetailScreen(configId: String) {
    val api = LocalApiClient.current
    val vm: ScheduledDetailViewModel = viewModel { ScheduledDetailViewModel(api, configId) }
    ScheduledDetailScreen(vm, baseUrl = api.baseUrl?.toString())
}

@Composable
internal fun ScheduledDetailScreen(vm: ScheduledDetailViewModel, baseUrl: String?) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current
    var showAddTrigger by remember { mutableStateOf(false) }
    LaunchedEffect(vm) { vm.refresh() }
    CollectUiMessages(vm.messages)
    ScheduledDetailContent(
        state = state,
        busy = busy,
        baseUrl = baseUrl,
        actions = ScheduledDetailActions(
            retryLoad = vm::load,
            refresh = vm::load,
            runNow = vm::runNow,
            toggleEnabled = vm::toggleEnabled,
            // Recurring work is edited in the one Work form (web `/work/:id/edit`); the blueprint
            // form (iOS `TaskConfigFormSheet`) stays for its title template, priority and retries.
            edit = { navigator.push(EditWorkRoute(vm.configId)) },
            editSettings = { navigator.push(ScheduledFormRoute(vm.configId)) },
            addTrigger = { showAddTrigger = true },
            delete = vm::delete,
            setTriggerEnabled = vm::setTriggerEnabled,
            deleteTrigger = vm::deleteTrigger,
            openTask = { navigator.push(TaskDetailRoute(it)) },
        ),
    )
    if (showAddTrigger) {
        AddTriggerSheet(baseUrl = baseUrl, onAdd = vm::addTrigger, onDismiss = { showAddTrigger = false })
    }
}

/** What the page's controls do; defaults do nothing (screenshots). */
class ScheduledDetailActions(
    val retryLoad: () -> Unit = {},
    val refresh: () -> Unit = {},
    val runNow: () -> Unit = {},
    val toggleEnabled: () -> Unit = {},
    val edit: () -> Unit = {},
    val editSettings: () -> Unit = {},
    val addTrigger: () -> Unit = {},
    val delete: () -> Unit = {},
    val setTriggerEnabled: (TriggerRow, Boolean) -> Unit = { _, _ -> },
    val deleteTrigger: (TriggerRow) -> Unit = {},
    val openTask: (String) -> Unit = {},
)

/** The header's lines (iOS `DetailHeader(line:secondary:)`), for tests. */
internal object ScheduledHeaderText {
    fun line(c: TaskConfigRow, triggers: List<TriggerRow>): AnnotatedString? = metaText(
        RunFormatting.repoShortName(c.repoUrl),
        mono(c.repoBranch ?: "main"),
        RunFormatting.agentLabel(c.agentType),
        if (triggers.isEmpty()) "manual only" else "${triggers.size} trigger${if (triggers.size == 1) "" else "s"}",
    )

    fun secondary(triggers: List<TriggerRow>): String? = triggers.firstOrNull()?.let(ScheduleFormat::humanize)
}

@Composable
fun ScheduledDetailContent(
    state: LoadState<ScheduledDetail>,
    busy: Boolean,
    baseUrl: String?,
    actions: ScheduledDetailActions,
    modifier: Modifier = Modifier,
    initialSection: ScheduledSection = ScheduledSection.CONFIG,
) {
    val detail = state.value
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    var section by rememberSaveable { mutableStateOf(initialSection) }
    DetailScaffold(
        title = detail?.config?.name?.ifEmpty { null } ?: "Scheduled",
        modifier = modifier.testTag("scheduled-detail"),
        actions = {
            if (detail != null && canMutate) {
                val config = detail.config
                OverflowMenu(
                    busy = busy,
                    items = listOf(
                        MenuAction("Run now", Icons.Outlined.PlayArrow, testTag = "action-run-now", onClick = actions.runNow),
                        if (config.enabled) {
                            MenuAction("Pause", Icons.Outlined.Pause, testTag = "action-pause", onClick = actions.toggleEnabled)
                        } else {
                            MenuAction("Resume", Icons.Outlined.PlayArrow, testTag = "action-resume", onClick = actions.toggleEnabled)
                        },
                        MenuAction("Edit", Icons.Outlined.Edit, testTag = "action-edit", onClick = actions.edit),
                        MenuAction("Edit blueprint settings", Icons.Outlined.Tune, testTag = "action-edit-settings", onClick = actions.editSettings),
                        MenuAction("Add trigger", Icons.Outlined.Bolt, testTag = "action-add-trigger", onClick = actions.addTrigger),
                        MenuAction("Delete", Icons.Outlined.Delete, destructive = true, dividerBefore = true, testTag = "action-delete") {
                            confirm.ask("Delete \"${config.name}\"?", "This removes all triggers.", "Delete", destructive = true, onConfirm = actions.delete)
                        },
                    ),
                )
            }
        },
    ) { padding ->
        Loadable(state = state, onRetry = actions.retryLoad, onRefresh = actions.refresh, what = "schedule", modifier = Modifier.padding(padding)) { value ->
            val config = value.config
            LazyColumn(Modifier.fillMaxSize().readableWidth(), contentPadding = PaddingValues(bottom = Spacing.xl)) {
                item(key = "header") {
                    DetailHeader(
                        state = if (config.enabled) "active" else "paused",
                        tone = if (config.enabled) Tone.WORKING else Tone.IDLE,
                        line = ScheduledHeaderText.line(config, value.triggers),
                        secondary = ScheduledHeaderText.secondary(value.triggers)?.let(::AnnotatedString),
                    )
                }
                item(key = "tabs") {
                    DetailTabs(options = ScheduledSection.entries.map { it to it.label }, selection = section, onSelect = { section = it })
                }
                when (section) {
                    ScheduledSection.CONFIG -> item(key = "config") { ConfigList(config) }
                    ScheduledSection.TRIGGERS -> item(key = "triggers") {
                        GroupedSection {
                            if (value.triggers.isEmpty()) {
                                Text(
                                    "No triggers — this blueprint only runs when you tap Run now.",
                                    style = OptioTheme.type.body,
                                    color = OptioTheme.colors.secondaryLabel,
                                    modifier = Modifier.padding(Spacing.l),
                                )
                            }
                            value.triggers.forEachIndexed { index, t ->
                                if (index > 0) InsetDivider(start = 64.dp)
                                TriggerRowView(
                                    trigger = t,
                                    baseUrl = baseUrl,
                                    onToggle = if (canMutate) ({ on -> actions.setTriggerEnabled(t, on) }) else null,
                                    onDelete = if (canMutate) {
                                        { confirm.ask("Delete ${t.label.lowercase()} trigger?", null, "Delete", destructive = true) { actions.deleteTrigger(t) } }
                                    } else {
                                        null
                                    },
                                )
                            }
                            if (canMutate) {
                                InsetDivider()
                                AddRow("Add trigger", onClick = actions.addTrigger, icon = Icons.Outlined.Bolt, modifier = Modifier.testTag("add-trigger"))
                            }
                        }
                    }
                    ScheduledSection.RUNS -> item(key = "runs") {
                        GroupedSection {
                            if (value.runs.isEmpty()) {
                                Text("No runs yet.", style = OptioTheme.type.body, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(Spacing.l))
                            }
                            value.runs.forEachIndexed { index, run ->
                                if (index > 0) InsetDivider()
                                TaskRowView(run, onClick = { actions.openTask(run.id) })
                            }
                        }
                    }
                }
            }
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun ConfigList(c: TaskConfigRow) {
    Column {
        GroupedSection {
            val rows = listOf(
                "Repository" to RunFormatting.repoShortName(c.repoUrl),
                "Branch" to (c.repoBranch ?: "main"),
                "Agent" to RunFormatting.agentLabel(c.agentType),
                "Priority" to "${c.priority ?: 100}",
                "Max retries" to "${c.maxRetries ?: 3}",
            )
            rows.forEachIndexed { index, (label, value) ->
                if (index > 0) InsetDivider()
                KeyValueRow(label, value, mono = label == "Branch")
            }
        }
        c.description?.takeIf { it.isNotEmpty() }?.let { description ->
            GroupedSection(header = "Description") {
                Text(description, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.padding(Spacing.l))
            }
        }
        GroupedSection(header = "Task title template") {
            Text(c.title, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.padding(Spacing.l))
        }
        GroupedSection(header = "Prompt") {
            CodeBlock(c.prompt, modifier = Modifier.padding(Spacing.m), background = OptioTheme.colors.fillQuaternary)
        }
    }
}
