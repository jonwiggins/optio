package dev.optio.feature.sessions

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.StopCircle
import androidx.compose.material.icons.outlined.Terminal
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
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.InteractiveSession
import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.SessionPr
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.terminal.TerminalState
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.launch

/** The chips of an active session (iOS `SessionDetailView.Section`). */
enum class SessionSection { CHAT, TERMINAL, PRS }

@Immutable
data class SessionChatUi(
    val rows: List<SessionChatRow> = emptyList(),
    val status: SessionChatConnection = SessionChatConnection.CONNECTING,
    val model: String? = null,
    val costUsd: Double = 0.0,
    val error: String? = null,
    val canSend: Boolean = false,
    val settled: Boolean = false,
    val historyLoaded: Boolean = false,
)

@Immutable
data class SessionTerminalUi(
    val connected: Boolean = false,
    val error: String? = null,
    val stopped: Boolean = false,
)

/** Everything the session screen shows, in one value (stateless content, screenshots). */
@Immutable
data class SessionDetailUi(
    val session: LoadState<SessionEnvelope> = LoadState.Idle,
    val prs: List<SessionPr> = emptyList(),
    val chat: SessionChatUi = SessionChatUi(),
    val terminal: SessionTerminalUi = SessionTerminalUi(),
    val ending: Boolean = false,
)

/** What the session screen can do; [SessionDetailViewModel] implements it through [of]. */
interface SessionDetailActions {
    fun send(text: String): Boolean

    fun interrupt()

    fun setModel(model: String)

    fun end()

    suspend fun refresh()

    suspend fun refreshPrs()

    /** The Terminal chip was opened. */
    fun openShell()

    fun reconnectShell()

    companion object {
        val None: SessionDetailActions =
            object : SessionDetailActions {
                override fun send(text: String) = true

                override fun interrupt() = Unit

                override fun setModel(model: String) = Unit

                override fun end() = Unit

                override suspend fun refresh() = Unit

                override suspend fun refreshPrs() = Unit

                override fun openShell() = Unit

                override fun reconnectShell() = Unit
            }

        fun of(vm: SessionDetailViewModel): SessionDetailActions =
            object : SessionDetailActions {
                override fun send(text: String) = vm.chat.send(text)

                override fun interrupt() = vm.chat.interrupt()

                override fun setModel(model: String) = vm.chat.setModel(model)

                override fun end() = vm.end()

                override suspend fun refresh() = vm.refresh()

                override suspend fun refreshPrs() = vm.refreshPrs()

                override fun openShell() = vm.openShell()

                override fun reconnectShell() = vm.shell.reconnect()
            }
    }
}

/**
 * An interactive pod session (iOS `SessionDetailView`): the header, then Chat · Terminal · PRs while
 * it is active, or what it left behind once ended. The overflow menu opens the repo and ends it.
 */
@Composable
fun SessionDetailScreen(
    sessionId: String,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val vm: SessionDetailViewModel = viewModel(key = "session:$sessionId") { SessionDetailViewModel(sessionId, api) }
    val session by vm.session.collectAsStateWithLifecycle()
    val prs by vm.prs.collectAsStateWithLifecycle()
    val ending by vm.ending.collectAsStateWithLifecycle()
    val rows by vm.chat.rows.collectAsStateWithLifecycle()
    val status by vm.chat.status.collectAsStateWithLifecycle()
    val model by vm.chat.model.collectAsStateWithLifecycle()
    val cost by vm.chat.costUsd.collectAsStateWithLifecycle()
    val chatError by vm.chat.error.collectAsStateWithLifecycle()
    val canSend by vm.chat.canSend.collectAsStateWithLifecycle()
    val settled by vm.chat.settled.collectAsStateWithLifecycle()
    val historyLoaded by vm.chat.historyLoaded.collectAsStateWithLifecycle()
    val shellConnected by vm.shell.connected.collectAsStateWithLifecycle()
    val shellError by vm.shell.error.collectAsStateWithLifecycle()
    val shellStopped by vm.shell.stopped.collectAsStateWithLifecycle()
    val toaster = LocalToaster.current
    val actions = remember(vm) { SessionDetailActions.of(vm) }

    LaunchedEffect(vm) { vm.appeared() }
    ConnectWhileShown(vm, connect = vm::connect, disconnect = vm::disconnect)
    LaunchedEffect(vm, toaster) {
        vm.events.collect { event ->
            when (event) {
                is SessionDetailViewModel.Event.Success -> toaster.success(event.message)
                is SessionDetailViewModel.Event.Failure -> toaster.error(event.error)
            }
        }
    }

    SessionDetailContent(
        ui =
            SessionDetailUi(
                session = session,
                prs = prs,
                chat = SessionChatUi(rows, status, model, cost, chatError, canSend, settled, historyLoaded),
                terminal = SessionTerminalUi(shellConnected, shellError, shellStopped),
                ending = ending,
            ),
        terminal = { vm.shell.terminal },
        actions = actions,
        modifier = modifier,
    )
}

/** The stateless session screen. [terminal] supplies the shell's emulator when its chip is shown. */
@Composable
fun SessionDetailContent(
    ui: SessionDetailUi,
    terminal: () -> TerminalState,
    actions: SessionDetailActions,
    modifier: Modifier = Modifier,
    initialSection: SessionSection = SessionSection.CHAT,
) {
    val navigator = LocalNavigator.current
    val confirm = rememberConfirmState()
    val scope = rememberCoroutineScope()
    var section by rememberSaveable { mutableStateOf(initialSection) }
    val envelope = ui.session.value
    val session = envelope?.session
    val active = session?.state == InteractiveSessionState.ACTIVE

    Scaffold(
        modifier = modifier.testTag("session-detail"),
        topBar = {
            TopAppBar(
                title = { Text(sessionTitle(session), maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    IconButton(onClick = navigator::pop, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = {
                    if (session != null && active) {
                        SessionMenu(
                            onOpenRepo = { navigator.openExternal(session.repoUrl) },
                            onEnd = {
                                confirm.ask(
                                    title = "End this session?",
                                    message = "The worktree will be cleaned up. Any un-pushed commits or changes will be lost.",
                                    confirmLabel = "End session",
                                    destructive = true,
                                ) { actions.end() }
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
            when {
                session != null -> {
                    val cost = displayCost(ui.chat.costUsd, session)
                    SessionHeaderView(session, ui.prs.size, cost, chatState = if (active) chatState(ui.chat) else null)
                    if (active) {
                        DetailTabs(
                            options =
                                listOf(
                                    SessionSection.CHAT to "Chat",
                                    SessionSection.TERMINAL to "Terminal",
                                    SessionSection.PRS to if (ui.prs.isEmpty()) "PRs" else "PRs (${ui.prs.size})",
                                ),
                            selection = section,
                            onSelect = { section = it },
                        )
                        HorizontalDivider(color = MaterialTheme.colorScheme.outlineVariant.copy(alpha = 0.5f))
                        val body = Modifier.weight(1f).fillMaxWidth()
                        when (section) {
                            SessionSection.CHAT -> SessionChatView(ui.chat, envelope.modelConfig, actions, body)
                            SessionSection.TERMINAL -> {
                                LaunchedEffect(Unit) { actions.openShell() }
                                SessionTerminalView(terminal(), ui.terminal, onReconnect = actions::reconnectShell, modifier = body)
                            }
                            SessionSection.PRS ->
                                SessionPrList(
                                    prs = ui.prs,
                                    onRefresh = actions::refreshPrs,
                                    onOpen = navigator::openExternal,
                                    modifier = body,
                                )
                        }
                    } else {
                        EndedBody(session, ui.prs, cost, onOpen = navigator::openExternal)
                    }
                }
                ui.session is LoadState.Failed ->
                    ErrorRow(error = ui.session.error, what = "session", retry = { scope.launch { actions.refresh() } })
                else -> SkeletonRows()
            }
        }
    }
    ConfirmHost(confirm)
}

/** What the header says about the chat, if anything (iOS `chatState`). */
internal fun chatState(chat: SessionChatUi): String? =
    when {
        chat.status == SessionChatConnection.THINKING -> "thinking"
        chat.canSend -> null
        // Ready, but the history replay isn't over: still connecting as far as you're concerned.
        chat.status == SessionChatConnection.READY || chat.status == SessionChatConnection.IDLE -> "connecting"
        else -> chat.status.label
    }

/** The session's header (iOS `SessionDetailView.header`). */
@Composable
internal fun SessionHeaderView(
    session: InteractiveSession,
    prCount: Int,
    cost: Double,
    chatState: String?,
    modifier: Modifier = Modifier,
) {
    val now = rememberNow()
    DetailHeader(
        state = if (session.state == InteractiveSessionState.UNKNOWN) "unknown" else session.state.raw,
        line =
            metaText(
                InsightsFormat.repoShortName(session.repoUrl),
                "started ${session.createdAt.relativeDescription(now)}",
                Cost.formatIfNonZero(cost),
                if (prCount == 0) null else "$prCount PR${if (prCount == 1) "" else "s"}",
                chatState,
            ),
        secondary = session.branch.takeIf { it.isNotEmpty() }?.let(::mono),
        showsUsage = true,
        modifier = modifier,
    )
}

@Composable
private fun SessionMenu(
    onOpenRepo: () -> Unit,
    onEnd: () -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    IconButton(onClick = { open = true }, modifier = Modifier.testTag("session-menu")) {
        Icon(Icons.Outlined.MoreVert, contentDescription = "Session actions")
    }
    DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
        DropdownMenuItem(
            text = { Text("Open repo") },
            leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
            onClick = {
                open = false
                onOpenRepo()
            },
            modifier = Modifier.testTag("menu-open-repo"),
        )
        HorizontalDivider()
        val red = MaterialTheme.colorScheme.error
        DropdownMenuItem(
            text = { Text("End session", color = red) },
            leadingIcon = { Icon(Icons.Outlined.StopCircle, contentDescription = null, tint = red) },
            onClick = {
                open = false
                onEnd()
            },
            modifier = Modifier.testTag("menu-end-session"),
        )
    }
}

/** An ended session: when it ended, what it cost, the PRs it opened (iOS `endedBody`). */
@Composable
private fun EndedBody(
    session: InteractiveSession,
    prs: List<SessionPr>,
    cost: Double,
    onOpen: (String) -> Unit,
) {
    val now = rememberNow()
    Column(Modifier.fillMaxSize().verticalScroll(rememberScrollState()).testTag("session-ended")) {
        EmptyState(
            title = "Session ended",
            icon = Icons.Outlined.Terminal,
            message = session.endedAt?.let { "Ended ${it.relativeDescription(now)}" },
        )
        if (cost > 0) {
            Text(
                "Cost ${Cost.format(cost)}",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
                textAlign = TextAlign.Center,
                modifier = Modifier.fillMaxWidth().padding(bottom = Spacing.m),
            )
        }
        prs.forEachIndexed { index, pr ->
            SessionPrRow(pr, onOpen = { onOpen(pr.prUrl) })
            if (index < prs.lastIndex) InsetDivider()
        }
    }
}
