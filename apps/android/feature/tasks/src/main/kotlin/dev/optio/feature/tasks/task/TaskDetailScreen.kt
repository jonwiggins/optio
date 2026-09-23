package dev.optio.feature.tasks.task

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.AddTask
import androidx.compose.material.icons.outlined.Bedtime
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material.icons.outlined.Close
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RateReview
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.WarningAmber
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.NoticeBanner
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.pathTail
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.tasks.common.CollectUiMessages
import dev.optio.feature.tasks.common.DetailScaffold
import dev.optio.feature.tasks.common.MenuAction
import dev.optio.feature.tasks.common.OverflowMenu
import dev.optio.feature.tasks.data.RunFormatting
import dev.optio.feature.tasks.data.TaskActivityItem
import dev.optio.feature.tasks.data.TaskRow
import java.time.Duration
import java.time.Instant
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay

/** The detail's segments (iOS `section`: logs · activity · subtasks · deps). */
enum class TaskSection(val label: String) { LOGS("Logs"), ACTIVITY("Activity"), SUBTASKS("Subtasks"), DEPS("Deps") }

/** `TaskDetailRoute(id)`: a Repo Task (iOS `TaskDetailView`). */
@Composable
fun TaskDetailScreen(taskId: String) {
    val api = LocalApiClient.current
    val vm: TaskDetailViewModel = viewModel { TaskDetailViewModel(api, taskId) }
    TaskDetailScreen(vm)
}

@Composable
internal fun TaskDetailScreen(vm: TaskDetailViewModel) {
    val state by vm.state.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val entries by vm.logs.entries.collectAsStateWithLifecycle()
    val connected by vm.logs.connected.collectAsStateWithLifecycle()
    val logsLoaded by vm.logs.loaded.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current

    // iOS `.task`: load on appear (refresh when coming back), then poll every 10 s while on screen.
    LaunchedEffect(vm) {
        vm.refresh()
        while (true) {
            delay(10.seconds)
            vm.refresh()
        }
    }
    // The log socket lives while the screen shows (iOS `.onDisappear { logs.stop() }`).
    DisposableEffect(vm) {
        vm.logs.start()
        onDispose { vm.logs.stop() }
    }
    CollectUiMessages(vm.messages)

    var showCreateSubtask by remember { mutableStateOf(false) }
    var showAddDependency by remember { mutableStateOf(false) }

    TaskDetailContent(
        state = state,
        logEntries = entries,
        logConnected = connected,
        logLoaded = logsLoaded,
        busy = busy,
        actions = TaskDetailActions(
            retryLoad = vm::load,
            refresh = vm::load,
            cancel = vm::cancel,
            retry = vm::retry,
            start = vm::start,
            attemptResume = vm::attemptResume,
            requestReview = vm::requestReview,
            runNow = vm::runNow,
            forceRedo = vm::forceRedo,
            approvePlan = vm::approvePlan,
            send = vm::send,
            addComment = vm::addComment,
            deleteComment = vm::deleteComment,
            removeDependency = vm::removeDependency,
            newSubtask = { showCreateSubtask = true },
            addDependency = { showAddDependency = true },
            openTask = { navigator.push(TaskDetailRoute(it)) },
            openTerminal = { navigator.push(LocalTerminalRoute(it)) },
            openUrl = navigator::openExternal,
        ),
    )

    if (showCreateSubtask) {
        CreateSubtaskSheet(onCreate = vm::createSubtask, onDismiss = { showCreateSubtask = false })
    }
    if (showAddDependency) {
        AddDependencySheet(search = vm::dependencyCandidates, onPick = vm::addDependency, onDismiss = { showAddDependency = false })
    }
}

/** What the detail's controls do; defaults do nothing (screenshots, previews). */
class TaskDetailActions(
    val retryLoad: () -> Unit = {},
    val refresh: () -> Unit = {},
    val cancel: () -> Unit = {},
    val retry: () -> Unit = {},
    val start: () -> Unit = {},
    val attemptResume: () -> Unit = {},
    val requestReview: () -> Unit = {},
    val runNow: () -> Unit = {},
    val forceRedo: () -> Unit = {},
    val approvePlan: () -> Unit = {},
    val send: suspend (String, MessageMode) -> Boolean = { _, _ -> true },
    val addComment: suspend (String) -> Boolean = { true },
    val deleteComment: (String) -> Unit = {},
    val removeDependency: (String) -> Unit = {},
    val newSubtask: () -> Unit = {},
    val addDependency: () -> Unit = {},
    val openTask: (String) -> Unit = {},
    val openTerminal: (String) -> Unit = {},
    val openUrl: (String) -> Unit = {},
)

/** The stateless detail: header, banners, segments, and the chosen segment. */
@Composable
fun TaskDetailContent(
    state: LoadState<TaskDetail>,
    logEntries: List<AgentLogEntry>,
    logConnected: Boolean,
    logLoaded: Boolean,
    busy: Boolean,
    actions: TaskDetailActions,
    modifier: Modifier = Modifier,
    initialSection: TaskSection = TaskSection.LOGS,
) {
    val detail = state.value
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    var section by rememberSaveable { mutableStateOf(initialSection) }
    var messageMode by rememberSaveable { mutableStateOf(MessageMode.SOFT) }

    DetailScaffold(
        title = detail?.task?.title?.ifEmpty { null } ?: "Task",
        modifier = modifier.testTag("task-detail"),
        actions = {
            if (detail != null) {
                OverflowMenu(items = menuItems(detail, canMutate, actions) { title, message, label, act ->
                    confirm.ask(title, message, label, destructive = true, onConfirm = act)
                }, busy = busy)
            }
        },
        bottomBar = {
            if (detail != null) {
                when (section) {
                    TaskSection.LOGS -> LogsComposer(detail, busy, canMutate, messageMode, onMode = { messageMode = it }, actions)
                    TaskSection.ACTIVITY -> ChatComposer(
                        onSend = { actions.addComment(it) },
                        placeholder = "Add a comment",
                        enabled = !busy,
                        modifier = Modifier.testTag("comment-composer"),
                    )
                    else -> Unit
                }
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                detail != null -> {
                    TaskHeader(detail, onOpenPr = actions.openUrl)
                    TaskBanners(detail, onOpenTerminal = actions.openTerminal)
                    DetailTabs(
                        options = TaskSection.entries.map { it to it.label },
                        selection = section,
                        onSelect = { section = it },
                    )
                    Box(Modifier.weight(1f).fillMaxWidth()) {
                        when (section) {
                            TaskSection.LOGS -> LogsSection(detail, logEntries, logConnected, logLoaded)
                            TaskSection.ACTIVITY -> ActivitySection(detail.activity, onDelete = { item ->
                                confirm.ask("Delete this comment?", null, "Delete", destructive = true) { actions.deleteComment(item.id) }
                            })
                            TaskSection.SUBTASKS -> SubtasksSection(detail.subtasks, canMutate, actions)
                            TaskSection.DEPS -> DependenciesSection(detail, canMutate, actions, onRemove = { dep ->
                                confirm.ask("Remove this dependency?", "\"${dep.title}\" no longer has to finish first.", "Remove", destructive = true) {
                                    actions.removeDependency(dep.id)
                                }
                            })
                        }
                    }
                }
                state is LoadState.Failed -> ErrorRow(state.error, what = "task", retry = actions.retryLoad)
                else -> SkeletonRows()
            }
        }
    }
    ConfirmHost(confirm)
}

private fun menuItems(
    detail: TaskDetail,
    canMutate: Boolean,
    actions: TaskDetailActions,
    ask: (title: String, message: String?, label: String, act: () -> Unit) -> Unit,
): List<MenuAction> = buildList {
    if (canMutate) {
        if (detail.canCancel) add(MenuAction("Cancel task", Icons.Outlined.Cancel, destructive = true, testTag = "action-cancel") { ask("Cancel this task?", null, "Cancel task", actions.cancel) })
        if (detail.canRetry) add(MenuAction("Retry", Icons.Outlined.Replay, testTag = "action-retry", onClick = actions.retry))
        if (detail.canStart) add(MenuAction("Start", Icons.Outlined.PlayArrow, testTag = "action-start", onClick = actions.start))
        if (detail.canForceRestart) add(MenuAction("Attempt resume", Icons.Outlined.RestartAlt, testTag = "action-attempt-resume", onClick = actions.attemptResume))
        if (detail.canRequestReview) add(MenuAction("Request review", Icons.Outlined.RateReview, testTag = "action-review", onClick = actions.requestReview))
        if (detail.canRunNow) add(MenuAction("Run now", Icons.Outlined.Bolt, testTag = "action-run-now", onClick = actions.runNow))
        add(
            MenuAction("Force redo", Icons.Outlined.Replay, destructive = true, dividerBefore = true, testTag = "action-force-redo") {
                ask("Force redo this task?", "Force redo clears all logs and results and re-runs the task from scratch.", "Force redo", actions.forceRedo)
            },
        )
        add(MenuAction("New subtask", Icons.Outlined.AddTask, testTag = "action-new-subtask", onClick = actions.newSubtask))
    }
    add(MenuAction("Refresh", Icons.Outlined.Refresh, testTag = "action-refresh", onClick = actions.refresh))
}

// region Header and banners

/** The header lines (iOS `header(_:)`), for tests. */
internal object TaskHeaderText {
    fun facts(task: TaskRow, now: Instant): AnnotatedString? {
        val timing = when {
            task.startedAt != null && task.completedAt != null -> RunFormatting.duration(Duration.between(task.startedAt, task.completedAt).toMillis().toDouble())
            task.startedAt != null -> "started ${task.startedAt.relativeDescription(now)}"
            task.createdAt != null -> "created ${task.createdAt.relativeDescription(now)}"
            else -> null
        }
        return metaText(
            timing,
            task.modelUsed?.let(InsightsFormat::modelShortName),
            RunFormatting.agentLabel(task.agentType),
            Cost.formatIfNonZero(task.costUsd),
            task.taskType?.takeIf { it != "coding" },
        )
    }

    fun secondary(task: TaskRow): AnnotatedString? {
        val parts = mutableListOf<CharSequence?>(task.repoShortName.takeIf { it.isNotEmpty() })
        task.repoBranch?.let { parts += mono(it) }
        if (task.isLocal) parts += mono(task.localDir?.pathTail() ?: "your machine")
        if (task.prUrl != null) {
            parts += mono(task.prLabel ?: "PR")
            task.prChecksStatus?.takeIf { it != "none" }?.let { parts += "CI $it" }
            task.prReviewStatus?.takeIf { it != "none" }?.let { parts += "review ${it.replace('_', ' ')}" }
            task.prState?.takeIf { it != "open" }?.let { parts += it }
        }
        return metaText(parts)
    }

    fun needsYou(detail: TaskDetail): String? = when {
        detail.state == "needs_attention" -> detail.task.errorMessage ?: "Needs your attention"
        detail.isStalled -> "Agent looks stuck — check the logs"
        detail.task.prReviewStatus == "changes_requested" -> "Reviewer requested changes"
        else -> null
    }
}

@Composable
private fun TaskHeader(detail: TaskDetail, onOpenPr: (String) -> Unit) {
    val now = LocalClock.current.instant()
    val task = detail.task
    val stalled = detail.isStalled
    DetailHeader(
        state = if (stalled) "stalled" else task.state,
        tone = if (stalled || task.state == "needs_attention") Tone.WORKING else null,
        line = TaskHeaderText.facts(task, now),
        secondary = TaskHeaderText.secondary(task),
        needsYou = TaskHeaderText.needsYou(detail),
        showsUsage = true,
    ) {
        task.prUrl?.let { url ->
            IconButton(onClick = { onOpenPr(url) }, modifier = Modifier.size(32.dp).testTag("open-pr")) {
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open pull request", modifier = Modifier.size(18.dp))
            }
        }
    }
}

@Composable
private fun TaskBanners(detail: TaskDetail, onOpenTerminal: (String) -> Unit) {
    val task = detail.task
    detail.pendingReason?.let { reason ->
        Banner(reason, if ("off-peak" in reason) Icons.Outlined.Bedtime else Icons.Outlined.Schedule, Tone.IDLE, "banner-pending")
    }
    detail.stallInfo?.takeIf { it.isStalled && task.state == "running" }?.let { stall ->
        val last = stall.lastLogSummary?.let { " Last: $it" }.orEmpty()
        Banner("No activity for ${RunFormatting.duration(stall.silentForMs)}.$last", Icons.Outlined.WarningAmber, Tone.WORKING, "banner-stalled")
    }
    if (task.state == "failed") {
        task.errorMessage?.let { Banner(it, Icons.Outlined.ErrorOutline, Tone.DANGER, "banner-failed", maxLines = 5) }
    }
    if (task.state == "completed") {
        task.resultSummary?.takeIf { it.isNotEmpty() }?.let { Banner(it, Icons.Outlined.CheckCircle, Tone.SUCCESS, "banner-summary", maxLines = 5) }
    }
    if (detail.isPlanReview) {
        Banner("Plan ready for review — check the agent output, then send feedback or approve.", Icons.Outlined.Checklist, Tone.ACCENT, "banner-plan")
    }
    if (task.isLocal) {
        // Web: a local task's session replaces the pod log; here it opens the Local terminal.
        NoticeBanner(
            tone = Tone.IDLE,
            icon = Icons.Outlined.Laptop,
            title = "Runs on your machine",
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.xs).testTag("banner-local"),
        ) {
            val terminalId = task.localTerminalId
            if (terminalId != null) {
                TextButton(onClick = { onOpenTerminal(terminalId) }, contentPadding = PaddingValues(0.dp), modifier = Modifier.testTag("open-terminal")) {
                    Text("Open the session")
                }
            } else {
                Text("Its session appears once the daemon picks it up${task.localDir?.let { " ($it)" }.orEmpty()}.")
            }
        }
    }
}

@Composable
private fun Banner(text: String, icon: ImageVector, tone: Tone, tag: String, maxLines: Int = 3) {
    NoticeBanner(tone = tone, modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.xs).testTag(tag)) {
        Row(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalAlignment = Alignment.Top) {
            Icon(icon, contentDescription = null, tint = tone.textColor, modifier = Modifier.padding(top = 1.dp).size(16.dp))
            Text(text, maxLines = maxLines, overflow = TextOverflow.Ellipsis)
        }
    }
}

// endregion

// region Logs

@Composable
private fun LogsSection(detail: TaskDetail, entries: List<AgentLogEntry>, connected: Boolean, loaded: Boolean) {
    if (entries.isEmpty()) {
        val active = !detail.isTerminal && detail.state !in setOf("pr_opened", "needs_attention")
        Column(
            Modifier.fillMaxSize().padding(Spacing.xl).testTag("logs-empty"),
            verticalArrangement = Arrangement.spacedBy(6.dp, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (!loaded || active) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            Text(
                when {
                    !loaded -> "Connecting…"
                    active -> if (connected) "Waiting for output…" else "Connecting…"
                    else -> "No logs recorded"
                },
                style = OptioTheme.type.caption,
                color = OptioTheme.colors.secondaryLabel,
            )
        }
    } else {
        AgentLogView(entries = entries)
    }
}

@Composable
private fun LogsComposer(
    detail: TaskDetail,
    busy: Boolean,
    canMutate: Boolean,
    mode: MessageMode,
    onMode: (MessageMode) -> Unit,
    actions: TaskDetailActions,
) {
    if (!canMutate) return
    if (detail.showsComposer) {
        Column(Modifier.fillMaxWidth().testTag("task-composer")) {
            when {
                detail.canMessageRunning -> ModePicker(mode, onMode)
                detail.isPlanReview -> Box(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.xs)) {
                    Button(onClick = actions.approvePlan, enabled = !busy, modifier = Modifier.testTag("approve-plan")) {
                        Text("Approve plan and start implementation")
                    }
                }
            }
            ChatComposer(
                onSend = { actions.send(it, mode) },
                placeholder = if (detail.canMessageRunning) "Message the running agent…" else "Resume the agent with a message…",
                enabled = !busy,
            )
        }
    } else if (detail.resumeUnavailable) {
        Text(
            "Resume unavailable — no session was captured for this task.",
            style = OptioTheme.type.caption,
            color = OptioTheme.colors.secondaryLabel,
            textAlign = TextAlign.Center,
            modifier = Modifier.fillMaxWidth().windowInsetsPadding(WindowInsets.navigationBars).padding(Spacing.s).testTag("resume-unavailable"),
        )
    }
}

/** Soft / Interrupt for a running agent (iOS `Picker("Mode")`, a menu). */
@Composable
private fun ModePicker(mode: MessageMode, onMode: (MessageMode) -> Unit) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth().padding(horizontal = Spacing.s)) {
        TextButton(onClick = { open = true }, modifier = Modifier.testTag("message-mode")) {
            Text(mode.label, style = OptioTheme.type.caption)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            MessageMode.entries.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option.label, color = if (option == mode) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface) },
                    onClick = {
                        open = false
                        onMode(option)
                    },
                )
            }
        }
    }
}

// endregion

// region Activity, subtasks, dependencies

@Composable
private fun ActivitySection(activity: List<TaskActivityItem>, onDelete: (TaskActivityItem) -> Unit) {
    val me = LocalCurrentUser.current
    LazyColumn(Modifier.fillMaxSize().testTag("activity-list")) {
        if (activity.isEmpty()) {
            item { Empty("No activity yet") }
        }
        items(activity, key = { it.type + it.id }) { item ->
            // Authors delete their own comments (and anyone, those made with auth off).
            val mine = item.isComment && (item.user?.id == null || me == null || item.user.id == me.id)
            TaskActivityRow(item, onDelete = if (mine) ({ onDelete(item) }) else null)
            InsetDivider()
        }
    }
}

@Composable
private fun SubtasksSection(subtasks: List<TaskRow>, canMutate: Boolean, actions: TaskDetailActions) {
    LazyColumn(Modifier.fillMaxSize().testTag("subtasks-list")) {
        if (subtasks.isEmpty()) item { Empty("No subtasks") }
        items(subtasks, key = { it.id }) { sub ->
            TaskRowView(sub, onClick = { actions.openTask(sub.id) })
            InsetDivider()
        }
        if (canMutate) {
            item { AddRow("New subtask", onClick = actions.newSubtask, icon = Icons.Outlined.Add, modifier = Modifier.testTag("new-subtask")) }
        }
    }
}

@Composable
private fun DependenciesSection(detail: TaskDetail, canMutate: Boolean, actions: TaskDetailActions, onRemove: (TaskRow) -> Unit) {
    LazyColumn(Modifier.fillMaxSize().testTag("deps-list"), contentPadding = PaddingValues(bottom = Spacing.xl)) {
        item {
            GroupedSection(header = "Depends on") {
                if (detail.dependencies.isEmpty()) Empty("None", padded = false)
                detail.dependencies.forEachIndexed { index, dep ->
                    if (index > 0) InsetDivider()
                    TaskRowView(
                        dep,
                        onClick = { actions.openTask(dep.id) },
                        trailingContent = if (canMutate) {
                            {
                                IconButton(onClick = { onRemove(dep) }, modifier = Modifier.size(36.dp).testTag("remove-dep-${dep.id}")) {
                                    Icon(Icons.Outlined.Close, contentDescription = "Remove dependency", tint = OptioTheme.colors.tertiaryLabel, modifier = Modifier.size(18.dp))
                                }
                            }
                        } else {
                            null
                        },
                    )
                }
                if (canMutate) {
                    InsetDivider()
                    AddRow("Add dependency", onClick = actions.addDependency, icon = Icons.Outlined.Add, modifier = Modifier.testTag("add-dependency"))
                }
            }
        }
        item {
            GroupedSection(header = "Blocks") {
                if (detail.dependents.isEmpty()) Empty("None", padded = false)
                detail.dependents.forEachIndexed { index, dep ->
                    if (index > 0) InsetDivider()
                    TaskRowView(dep, onClick = { actions.openTask(dep.id) })
                }
            }
        }
    }
}

@Composable
private fun Empty(text: String, padded: Boolean = true) {
    Text(
        text,
        style = OptioTheme.type.body,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(horizontal = Spacing.l, vertical = if (padded) Spacing.l else Spacing.m),
    )
}

// endregion
