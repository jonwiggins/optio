package dev.optio.feature.agents

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Archive
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.RestartAlt
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AgentFormRoute
import dev.optio.core.navigation.routes.AgentTurnRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster

/** The chips of the agent screen (iOS `AgentDetailView.Section`). */
enum class AgentSection(val label: String) {
    CHAT("Chat"),
    TURNS("Turns"),
    TRIGGERS("Triggers"),
    CONFIG("Config"),
}

/**
 * Chat-first detail for one persistent agent (iOS `AgentDetailView`): the header, then chips
 * Chat · Turns · Triggers · Config, live over `/ws/persistent-agents/:id/events`. [compose] (the
 * `optio://agents/<id>?compose=1` deep link, a notification's Reply) lands on Chat with the
 * composer focused.
 */
@Composable
fun AgentDetailScreen(
    agentId: String,
    compose: Boolean = false,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val vm: AgentDetailViewModel = viewModel(key = "agent:$agentId") { AgentDetailViewModel(agentId, api) }
    val header by vm.header.collectAsStateWithLifecycle()
    val messages by vm.messages.collectAsStateWithLifecycle()
    val turns by vm.turns.collectAsStateWithLifecycle()
    val triggers by vm.triggers.collectAsStateWithLifecycle()
    val live by vm.live.collectAsStateWithLifecycle()
    val connected by vm.connected.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current

    LaunchedEffect(vm) { vm.appeared() }
    ConnectWhileShown(vm, connect = vm::connect, disconnect = vm::disconnect)
    LaunchedEffect(vm, toaster) {
        vm.events.collect { event ->
            when (event) {
                is AgentDetailViewModel.Event.Success -> toaster.success(event.message)
                is AgentDetailViewModel.Event.Failure -> toaster.error(event.error, event.what)
                AgentDetailViewModel.Event.Deleted -> {
                    toaster.success("Agent deleted")
                    navigator.pop()
                }
            }
        }
    }

    AgentDetailContent(
        ui = AgentDetailUi(header, messages, turns, triggers, live, connected),
        actions = vm,
        focusComposer = compose,
        onRetry = { vm.appeared() },
        modifier = modifier,
    )
}

/** The stateless agent screen: everything [AgentDetailScreen] shows, for a given [ui]. */
@Composable
fun AgentDetailContent(
    ui: AgentDetailUi,
    actions: AgentDetailActions,
    modifier: Modifier = Modifier,
    focusComposer: Boolean = false,
    initialSection: AgentSection = AgentSection.CHAT,
    onRetry: () -> Unit = {},
) {
    val navigator = LocalNavigator.current
    val confirm = rememberConfirmState()
    val canMutate = Roles.canMutate
    var section by rememberSaveable { mutableStateOf(initialSection) }
    // The deep link focuses the composer once, not every time Chat comes back.
    var pendingFocus by rememberSaveable { mutableStateOf(focusComposer) }
    var showNewTrigger by rememberSaveable { mutableStateOf(false) }
    val agent = ui.agent

    Scaffold(
        modifier = modifier.testTag("agent-detail"),
        topBar = {
            TopAppBar(
                title = { Text(agent?.name ?: "Agent", maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = navigator::pop, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (agent != null && canMutate) {
                        AgentMenu(
                            agent = agent,
                            onControl = actions::control,
                            onEdit = { navigator.push(AgentFormRoute(agent.id)) },
                            onArchive = {
                                confirm.ask(
                                    title = "Archive this agent?",
                                    message = "Archived agents stop waking and are kept for history.",
                                    confirmLabel = "Archive",
                                    destructive = true,
                                ) { actions.control(PersistentAgentControlIntent.ARCHIVE) }
                            },
                            onDelete = {
                                confirm.ask(
                                    title = "Delete this agent and all its turn history?",
                                    confirmLabel = "Delete",
                                    destructive = true,
                                ) { actions.delete() }
                            },
                        )
                    }
                },
            )
        },
    ) { padding ->
        Column(
            Modifier
                .fillMaxSize()
                .padding(padding)
                .consumeWindowInsets(padding)
                .imePaddingInWindow(),
        ) {
            val header = ui.header
            val loaded = header.value
            when {
                loaded != null -> AgentHeaderView(loaded, connected = ui.connected)
                header is LoadState.Failed -> ErrorRow(error = header.error, what = "agent", retry = onRetry)
                else -> SkeletonRows(count = 1)
            }
            DetailTabs(
                options = AgentSection.entries.map { it to it.label },
                selection = section,
                onSelect = { section = it },
            )
            HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
            Box(Modifier.weight(1f).fillMaxWidth()) {
                when (section) {
                    AgentSection.CHAT -> AgentChatSection(ui.messages, ui.live, ui.turns.value.orEmpty(), onRefresh = actions::refresh)
                    AgentSection.TURNS ->
                        AgentTurnsSection(
                            turns = ui.turns,
                            onRefresh = actions::refresh,
                            onOpen = { turn -> navigator.push(AgentTurnRoute(turn.agentId, turn.id, turn.turnNumber.toInt())) },
                        )
                    AgentSection.TRIGGERS ->
                        AgentTriggersSection(
                            triggers = ui.triggers,
                            onRefresh = actions::refresh,
                            onAdd = { showNewTrigger = true },
                            onDelete = { trigger ->
                                confirm.ask(
                                    title = "Delete this ${trigger.kind?.label?.lowercase() ?: trigger.type} trigger?",
                                    message = "The agent stops waking from it.",
                                    confirmLabel = "Delete",
                                    destructive = true,
                                ) { actions.deleteTrigger(trigger.id) }
                            },
                        )
                    AgentSection.CONFIG -> AgentConfigSection(agent, onEdit = { agent?.let { navigator.push(AgentFormRoute(it.id)) } })
                }
            }
            if (section == AgentSection.CHAT && canMutate) {
                val composerEnabled = agent != null && agent.state != PersistentAgentState.ARCHIVED
                ChatComposer(
                    // iOS also records the send so this agent's next turn joins the Watch for an hour
                    // (`RecentAgentSends.record`). Android: `WatchSources.get(context).recordAgentSend(id)`
                    // from :core:glance (agent A9), wired at integration once that module is merged here.
                    onSend = { text -> actions.send(text) },
                    placeholder = "Message ${agent?.name ?: "agent"}…",
                    enabled = composerEnabled,
                    // A disabled field can't take focus: hold the request until the agent has loaded.
                    autofocus = pendingFocus && composerEnabled,
                    windowInsets = WindowInsets(0, 0, 0, 0),
                )
                LaunchedEffect(composerEnabled) { if (composerEnabled) pendingFocus = false }
            }
        }
    }

    if (showNewTrigger) {
        AgentTriggerSheet(
            onDismiss = { showNewTrigger = false },
            onCreate = actions::createTrigger,
        )
    }
    ConfirmHost(confirm)
}

/** The agent's header (iOS `AgentDetailView.header`). */
@Composable
internal fun AgentHeaderView(
    header: AgentHeader,
    connected: Boolean,
    modifier: Modifier = Modifier,
) {
    val agent = header.agent
    val now = rememberNow()
    val pending = header.inbox.pending
    val needsYou =
        when {
            agent.state == PersistentAgentState.PAUSED -> "Paused — resume to keep going"
            pending > 0 -> "$pending message${if (pending == 1) "" else "s"} waiting"
            else -> null
        }
    val failures = agent.consecutiveFailures.toInt()
    val secondary =
        when {
            !agent.lastFailureReason.isNullOrEmpty() && failures > 0 -> "$failures failure${if (failures == 1) "" else "s"} · ${agent.lastFailureReason}"
            !agent.description.isNullOrEmpty() -> agent.description
            else -> null
        }
    DetailHeader(
        state = agent.state.label,
        tone = if (agent.state == PersistentAgentState.PAUSED) Tone.WORKING else null,
        line =
            metaText(
                mono("@${agent.slug}"),
                agent.agentRuntime,
                agent.podLifecycle.raw.takeUnless { agent.podLifecycle.isUnknown },
                agent.lastTurnAt?.let { "last turn ${it.sinceDescription(now)}" },
                Cost.formatIfNonZero(agent.totalCostUsd),
            ),
        // DetailHeader sets its second line in mono (paths, branches); a description is prose.
        secondary = secondary?.let(::prose),
        needsYou = needsYou,
        modifier = modifier,
    ) {
        if (connected) {
            StateDot(Tone.WORKING, size = 6.dp, modifier = Modifier.semantics { contentDescription = "Live" }.testTag("live-dot"))
        }
    }
}

/** The overflow menu (iOS toolbar `Menu`): Resume/Pause, Restart, Edit, Archive, Delete. */
@Composable
private fun AgentMenu(
    agent: PersistentAgent,
    onControl: (PersistentAgentControlIntent) -> Unit,
    onEdit: () -> Unit,
    onArchive: () -> Unit,
    onDelete: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }, modifier = Modifier.testTag("agent-menu")) {
        Icon(Icons.Outlined.MoreVert, contentDescription = "Agent actions")
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        val close = { open = false }
        when {
            agent.state == PersistentAgentState.PAUSED || agent.state == PersistentAgentState.FAILED ->
                MenuItem("Resume", Icons.Outlined.PlayArrow, close) { onControl(PersistentAgentControlIntent.RESUME) }
            agent.state != PersistentAgentState.ARCHIVED ->
                MenuItem("Pause", Icons.Outlined.Pause, close) { onControl(PersistentAgentControlIntent.PAUSE) }
        }
        MenuItem("Restart", Icons.Outlined.RestartAlt, close) { onControl(PersistentAgentControlIntent.RESTART) }
        MenuItem("Edit", Icons.Outlined.Edit, close, action = onEdit)
        HorizontalDivider()
        if (agent.state != PersistentAgentState.ARCHIVED) {
            MenuItem("Archive", Icons.Outlined.Archive, close, destructive = true, action = onArchive)
        }
        MenuItem("Delete", Icons.Outlined.DeleteOutline, close, destructive = true, action = onDelete)
    }
}

@Composable
private fun MenuItem(
    label: String,
    icon: ImageVector,
    close: () -> Unit,
    destructive: Boolean = false,
    action: () -> Unit,
) {
    val color = if (destructive) MaterialTheme.colorScheme.error else MaterialTheme.colorScheme.onSurface
    DropdownMenuItem(
        text = { Text(label, color = color) },
        leadingIcon = { Icon(icon, contentDescription = null, tint = color) },
        onClick = {
            close()
            action()
        },
        modifier = Modifier.testTag("menu-${label.lowercase()}"),
    )
}

/** [text] in the body font, inside a line styled mono. */
internal fun prose(text: String): AnnotatedString =
    buildAnnotatedString { withStyle(SpanStyle(fontFamily = FontFamily.Default)) { append(text) } }

/** The state as the API spells it (`paused`); "unknown" for a state this app doesn't know. */
internal val PersistentAgentState.label: String
    get() = if (this == PersistentAgentState.UNKNOWN) "unknown" else raw

internal val dev.optio.core.model.PersistentAgentPodLifecycle.isUnknown: Boolean
    get() = this == dev.optio.core.model.PersistentAgentPodLifecycle.UNKNOWN
