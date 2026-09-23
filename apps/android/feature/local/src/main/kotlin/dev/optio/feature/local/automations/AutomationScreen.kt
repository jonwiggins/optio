package dev.optio.feature.local.automations

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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.pulltorefresh.PullToRefreshBox
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.routes.LocalAutomationFormRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.StatItem
import dev.optio.core.ui.components.StatStrip
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.machines.whereText
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.TriggerKind
import dev.optio.feature.local.model.Triggers
import dev.optio.feature.local.ui.TerminalRow
import dev.optio.feature.local.ui.actionFailure
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * `LocalAutomationRoute`: one Local automation (iOS `LocalBlueprintDetailView`, web
 * `/local/automations/:id`). What it is, how it has been doing, what starts it (triggers, edited
 * here), and every terminal it spawned. Run now · Edit · Pause · Delete.
 */
@Composable
fun AutomationScreen(automationId: String) {
    val api = LocalApiClient.current
    val vm: AutomationViewModel = viewModel(key = "local-automation-$automationId") { AutomationViewModel(api, automationId) }
    LifecycleStartEffect(vm) {
        vm.attach()
        onStopOrDispose { vm.detach() }
    }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                is AutomationViewModel.Event.Toast -> toaster.success(event.message)
                is AutomationViewModel.Event.Failed -> toaster.error(actionFailure(event.error, event.verb))
                is AutomationViewModel.Event.Open -> navigator.push(event.route)
                AutomationViewModel.Event.Closed -> navigator.pop()
            }
        }
    }
    val page by vm.page.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    AutomationContent(
        page = page,
        busy = busy,
        canMutate = Roles.canMutate,
        serverUrl = api.baseUrl?.toString(),
        navigator = navigator,
        refreshing = refreshing,
        onRefresh = {
            scope.launch {
                refreshing = true
                vm.refresh()
                refreshing = false
            }
        },
        onRetry = vm::reload,
        onRun = vm::runNow,
        onSetEnabled = vm::setEnabled,
        onDelete = vm::delete,
        onAddTrigger = vm::addTrigger,
        onSetTriggerEnabled = vm::setTriggerEnabled,
        onDeleteTrigger = vm::deleteTrigger,
    )
}

@Composable
internal fun AutomationContent(
    page: LoadState<AutomationPage>,
    busy: Boolean,
    canMutate: Boolean,
    serverUrl: String?,
    navigator: Navigator = Navigator.None,
    refreshing: Boolean = false,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
    onRun: () -> Unit = {},
    onSetEnabled: (Boolean) -> Unit = {},
    onDelete: () -> Unit = {},
    onAddTrigger: suspend (TriggerKind, JsonObject) -> Unit = { _, _ -> },
    onSetTriggerEnabled: (LocalTrigger, Boolean) -> Unit = { _, _ -> },
    onDeleteTrigger: (LocalTrigger) -> Unit = {},
) {
    val data = page.value
    val confirm = rememberConfirmState()
    var addingTrigger by remember { mutableStateOf(false) }
    var menu by remember { mutableStateOf(false) }
    Scaffold(
        topBar = {
            TopAppBar(
                navigationIcon = {
                    IconButton(onClick = navigator::pop, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                title = {
                    Column {
                        Text(data?.automation?.name ?: "Automation", style = OptioTheme.type.subheadline.semibold(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        Text("Automation", style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel)
                    }
                },
                actions = {
                    if (data != null && canMutate) {
                        if (busy) {
                            CircularProgressIndicator(Modifier.padding(horizontal = 12.dp).size(20.dp), strokeWidth = 2.dp)
                        } else {
                            IconButton(onClick = onRun, modifier = Modifier.testTag("automation-run")) {
                                Icon(Icons.Outlined.PlayArrow, contentDescription = "Run now")
                            }
                        }
                        IconButton(onClick = { navigator.push(LocalAutomationFormRoute(data.automation.id)) }, modifier = Modifier.testTag("automation-edit")) {
                            Icon(Icons.Outlined.Edit, contentDescription = "Edit")
                        }
                        Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("automation-menu")) {
                                Icon(Icons.Outlined.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                val enabled = data.automation.enabled
                                DropdownMenuItem(
                                    text = { Text(if (enabled) "Pause" else "Enable") },
                                    leadingIcon = { Icon(if (enabled) Icons.Outlined.Pause else Icons.Outlined.PlayArrow, null) },
                                    onClick = {
                                        menu = false
                                        onSetEnabled(!enabled)
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text("Delete", color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menu = false
                                        confirm.ask(
                                            title = "Delete automation “${data.automation.name}” and its triggers?",
                                            message = "Past runs stay.",
                                            confirmLabel = "Delete",
                                            destructive = true,
                                            onConfirm = onDelete,
                                        )
                                    },
                                )
                            }
                        }
                    }
                },
            )
        },
    ) { padding ->
        PullToRefreshBox(isRefreshing = refreshing, onRefresh = onRefresh, modifier = Modifier.fillMaxSize().padding(padding)) {
            when {
                data != null ->
                    AutomationBody(
                        data = data,
                        canMutate = canMutate,
                        navigator = navigator,
                        onRun = onRun,
                        onSetEnabled = onSetEnabled,
                        onAddTrigger = { addingTrigger = true },
                        onSetTriggerEnabled = onSetTriggerEnabled,
                        onDeleteTrigger = { t ->
                            confirm.ask(
                                title = "Delete this ${Triggers.label(t).lowercase()} trigger?",
                                message = Triggers.summary(t),
                                confirmLabel = "Delete",
                                destructive = true,
                            ) { onDeleteTrigger(t) }
                        },
                    )
                page is LoadState.Failed ->
                    LazyColumn(Modifier.fillMaxSize()) { item { ErrorRow(error = page.error, what = "automation", retry = onRetry) } }
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp) }
            }
        }
    }
    ConfirmHost(confirm)
    if (addingTrigger) {
        AddTriggerSheet(serverUrl = serverUrl, onDismiss = { addingTrigger = false }, onSubmit = onAddTrigger)
    }
}

@Composable
private fun AutomationBody(
    data: AutomationPage,
    canMutate: Boolean,
    navigator: Navigator,
    onRun: () -> Unit,
    onSetEnabled: (Boolean) -> Unit,
    onAddTrigger: () -> Unit,
    onSetTriggerEnabled: (LocalTrigger, Boolean) -> Unit,
    onDeleteTrigger: (LocalTrigger) -> Unit,
) {
    val bp = data.automation
    val now = LocalClock.current.instant()
    val agent = bp.agent
    LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("automation-page"), contentPadding = PaddingValues(bottom = Spacing.xl)) {
        item {
            DetailHeader(
                state = if (bp.enabled) "Enabled" else "Paused",
                tone = if (bp.enabled) Tone.SUCCESS else Tone.IDLE,
                line =
                    metaText(
                        agent?.let(LocalPresentation::agentLabel) ?: "shell",
                        if (agent == null) null else if (bp.sessionMode == LocalAgentSessionMode.HEADLESS) "exit when done" else "keeps session open",
                        if (bp.spawnMode == LocalBlueprintSpawnMode.HOLD) "hold" else null,
                    ),
                secondary = whereText(bp, data.host?.name),
            )
        }
        item {
            val nextFire = data.nextFire
            StatStrip(
                items =
                    listOf(
                        StatItem("Runs", data.runs.size),
                        StatItem("Needs you", data.needsYou, tone = if (data.needsYou > 0) Tone.ACCENT else null),
                        StatItem("Total cost", if (data.totalCost > 0) Cost.format(data.totalCost) else "—", isZero = data.totalCost <= 0),
                        StatItem(
                            if (nextFire != null) "Next run" else "Last run",
                            nextFire?.relativeDescription(now) ?: data.lastRun?.relativeDescription(now) ?: "—",
                            isZero = nextFire == null && data.lastRun == null,
                        ),
                    ),
                modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
            )
        }
        if (!bp.description.isNullOrBlank()) {
            item {
                Text(bp.description!!, style = OptioTheme.type.subheadline, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(horizontal = Spacing.l * 2))
            }
        }
        item {
            GroupedSection(header = "Triggers", footer = if (data.triggers.isEmpty()) "Starts by hand only — Run now, or add a trigger." else null) {
                data.triggers.forEachIndexed { i, t ->
                    TriggerRow(t, canMutate, onSetEnabled = { onSetTriggerEnabled(t, it) }, onDelete = { onDeleteTrigger(t) })
                    if (i < data.triggers.lastIndex || canMutate) InsetDivider()
                }
                if (canMutate) {
                    TextButton(onClick = onAddTrigger, modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s).testTag("add-trigger")) {
                        Icon(Icons.Outlined.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Add trigger", modifier = Modifier.padding(start = Spacing.s).weight(1f))
                    }
                }
            }
        }
        item {
            GroupedSection(header = if (agent == null) "Command template" else "Prompt template") {
                CodeBlock(bp.commandTemplate.ifBlank { "(a saved prompt)" }, modifier = Modifier.padding(Spacing.m))
            }
        }
        item {
            GroupedSection(header = "Details") {
                KeyValueRow("Host", data.host?.name ?: bp.hostId?.let { "(unknown machine)" } ?: "Any online host")
                InsetDivider()
                KeyValueRow(
                    when {
                        bp.dir != null -> "Directory"
                        bp.repoUrl != null -> "Repo URL"
                        else -> "Where"
                    },
                    bp.dir ?: bp.repoUrl ?: "The event's repo, else the host's first directory",
                    mono = bp.dir != null || bp.repoUrl != null,
                )
                InsetDivider()
                KeyValueRow("Run as", agent?.let(LocalPresentation::agentLabel) ?: "Shell")
                if (agent != null) {
                    InsetDivider()
                    KeyValueRow("Then", if (bp.sessionMode == LocalAgentSessionMode.HEADLESS) "Exit when done" else "Keep the session open")
                }
                InsetDivider()
                KeyValueRow("Spawn mode", if (bp.spawnMode == LocalBlueprintSpawnMode.HOLD) "hold — create pending, start with one tap" else "auto — spawn immediately")
                InsetDivider()
                KeyValueRow("Enabled", null, trailing = {
                    Switch(checked = bp.enabled, onCheckedChange = onSetEnabled, enabled = canMutate, modifier = Modifier.testTag("automation-enabled"))
                })
            }
        }
        item {
            GroupedSection(header = "Runs · ${data.runs.size}", footer = if (data.runs.isEmpty()) "Nothing has run yet." else null) {
                data.runs.forEachIndexed { i, t ->
                    TerminalRow(t, onClick = { navigator.push(LocalTerminalRoute(t.id)) })
                    if (i < data.runs.lastIndex) InsetDivider()
                }
                if (data.runs.isEmpty() && canMutate) {
                    TextButton(onClick = onRun, modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.s).testTag("run-now")) {
                        Icon(Icons.Outlined.PlayArrow, contentDescription = null, modifier = Modifier.size(18.dp))
                        Text("Run it now", modifier = Modifier.padding(start = Spacing.s).weight(1f))
                    }
                }
            }
        }
    }
}

@Composable
private fun TriggerRow(
    trigger: LocalTrigger,
    canMutate: Boolean,
    onSetEnabled: (Boolean) -> Unit,
    onDelete: () -> Unit,
) {
    val now = LocalClock.current.instant()
    val colors = OptioTheme.colors
    val timing =
        listOfNotNull(
            trigger.nextFireAt?.takeIf { trigger.enabled }?.let { "next ${it.relativeDescription(now)}" },
            trigger.lastFiredAt?.let { "fired ${it.relativeDescription(now)}" },
        ).joinToString(" · ")
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = Spacing.l, end = Spacing.xs, top = Spacing.m, bottom = Spacing.m)
            .testTag("trigger-${trigger.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(Triggers.icon(trigger), contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(Triggers.label(trigger), style = OptioTheme.type.subheadline.semibold(), color = if (trigger.enabled) colors.label else colors.tertiaryLabel)
            Text(Triggers.summary(trigger), style = OptioTheme.type.caption.mono(), color = colors.secondaryLabel, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (timing.isNotEmpty()) Text(timing, style = OptioTheme.type.caption2, color = colors.tertiaryLabel)
        }
        if (canMutate) {
            Switch(checked = trigger.enabled, onCheckedChange = onSetEnabled, modifier = Modifier.testTag("trigger-enabled-${trigger.id}"))
            IconButton(onClick = onDelete, modifier = Modifier.testTag("trigger-delete-${trigger.id}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete trigger", tint = colors.tertiaryLabel)
            }
        }
    }
}
