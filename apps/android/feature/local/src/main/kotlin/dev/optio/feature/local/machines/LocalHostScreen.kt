package dev.optio.feature.local.machines

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
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
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.EventHub
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.network.unknown
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.local.api.deleteLocalHost
import dev.optio.feature.local.api.listLocalBlueprints
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.listLocalTerminals
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.ui.TerminalRow
import dev.optio.feature.local.ui.actionFailure
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.jsonPrimitive

/** Everything the machine page shows. */
data class HostPage(
    val host: LocalHost,
    val terminals: List<LocalTerminal>,
    val automations: List<LocalBlueprint>,
)

/**
 * The terminals on one machine, in the order you'd act on them: waiting on you (oldest wait
 * first), then running (newest activity first), pending, and finished (newest first). The web's
 * session rail groups the same way.
 */
object HostTerminals {
    enum class Group(val title: String) { NEEDS_YOU("Needs you"), RUNNING("Running"), PENDING("Pending"), FINISHED("Finished") }

    fun group(t: LocalTerminal): Group =
        when {
            LocalPresentation.waitsOnYou(t) -> Group.NEEDS_YOU
            t.state == LocalTerminalState.RUNNING || t.state == LocalTerminalState.LAUNCHING -> Group.RUNNING
            t.state == LocalTerminalState.PENDING -> Group.PENDING
            else -> Group.FINISHED
        }

    fun grouped(terminals: List<LocalTerminal>): List<Pair<Group, List<LocalTerminal>>> {
        val at = { t: LocalTerminal -> LocalPresentation.activityAt(t) ?: Instant.EPOCH }
        return Group.entries.mapNotNull { g ->
            val members = terminals.filter { group(it) == g }
            if (members.isEmpty()) return@mapNotNull null
            g to if (g == Group.NEEDS_YOU) members.sortedBy(at) else members.sortedByDescending(at)
        }
    }
}

/** `LocalHostRoute`'s state: the host (from the list: there is no single-host route), its terminals and automations. */
class LocalHostViewModel(
    private val api: ApiClient,
    val hostId: String,
    private val eventHub: EventHub? = null,
    private val pollInterval: Duration = 15.seconds,
) : ViewModel() {
    sealed interface Event {
        data class Failed(val error: Throwable, val verb: String) : Event

        data object Forgotten : Event
    }

    private val _page = MutableStateFlow<LoadState<HostPage>>(LoadState.Loading())
    val page: StateFlow<LoadState<HostPage>> = _page.asStateFlow()

    private val eventChannel = Channel<Event>(Channel.BUFFERED)
    val events = eventChannel.receiveAsFlow()

    private var pollJob: Job? = null
    private var nudgeJob: Job? = null

    init {
        viewModelScope.launch { refresh() }
    }

    suspend fun refresh() {
        val before = _page.value
        _page.value = LoadState.Loading(before.value)
        _page.value =
            try {
                LoadState.Loaded(fetch())
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                LoadState.Failed(e, before.value)
            }
    }

    private suspend fun fetch(): HostPage =
        coroutineScope {
            val hosts = async { api.listLocalHosts() }
            val terminals = async { api.listLocalTerminals(hostId = hostId) }
            val automations = async { runCatching { api.listLocalBlueprints() }.getOrDefault(emptyList()) }
            val host = hosts.await().firstOrNull { it.id == hostId } ?: throw NoSuchElementException("Machine not found")
            HostPage(host, terminals.await(), automations.await().filter { it.hostId == hostId })
        }

    fun reload() {
        viewModelScope.launch { refresh() }
    }

    private var attachedBefore = false

    fun attach() {
        if (attachedBefore) viewModelScope.launch { runCatching { _page.value = LoadState.Loaded(fetch()) } }
        attachedBefore = true
        if (pollJob == null) {
            pollJob =
                viewModelScope.launch {
                    while (isActive) {
                        delay(pollInterval)
                        runCatching { _page.value = LoadState.Loaded(fetch()) }
                    }
                }
        }
        val hub = eventHub
        if (nudgeJob == null && hub != null) {
            nudgeJob =
                viewModelScope.launch {
                    hub.unknown("local:changed")
                        .filter { it["hostId"]?.jsonPrimitive?.content == hostId }
                        .collect { runCatching { _page.value = LoadState.Loaded(fetch()) } }
                }
        }
    }

    fun detach() {
        pollJob?.cancel()
        pollJob = null
        nudgeJob?.cancel()
        nudgeJob = null
    }

    fun forget() {
        viewModelScope.launch {
            try {
                api.deleteLocalHost(hostId)
                eventChannel.send(Event.Forgotten)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, "forget the machine"))
            }
        }
    }
}

/** `LocalHostRoute`: one paired machine, its directories, the terminals on it, and its automations. */
@Composable
fun LocalHostScreen(hostId: String) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val vm: LocalHostViewModel = viewModel(key = "local-host-$hostId") { LocalHostViewModel(api, hostId, hub) }
    LifecycleStartEffect(vm) {
        vm.attach()
        onStopOrDispose { vm.detach() }
    }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                is LocalHostViewModel.Event.Failed -> toaster.error(actionFailure(event.error, event.verb))
                LocalHostViewModel.Event.Forgotten -> {
                    toaster.success("Machine forgotten")
                    navigator.pop()
                }
            }
        }
    }
    val page by vm.page.collectAsStateWithLifecycle()
    val scope = rememberCoroutineScope()
    var refreshing by remember { mutableStateOf(false) }
    LocalHostContent(
        page = page,
        canMutate = Roles.canMutate,
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
        onForget = vm::forget,
    )
}

@Composable
internal fun LocalHostContent(
    page: LoadState<HostPage>,
    canMutate: Boolean,
    navigator: Navigator = Navigator.None,
    refreshing: Boolean = false,
    onRefresh: () -> Unit = {},
    onRetry: () -> Unit = {},
    onForget: () -> Unit = {},
) {
    val data = page.value
    val confirm = rememberConfirmState()
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
                        Text(data?.host?.name ?: "Machine", style = OptioTheme.type.subheadline.semibold(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                        data?.host?.let { host ->
                            Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                                StateDot(if (host.state == LocalHostState.ONLINE) Tone.SUCCESS else Tone.IDLE, size = 6.dp, pulse = false)
                                Text(hostSeen(host), style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel)
                            }
                        }
                    }
                },
                actions = {
                    if (data != null && canMutate) {
                        Box {
                            IconButton(onClick = { menu = true }, modifier = Modifier.testTag("host-menu")) {
                                Icon(Icons.Outlined.MoreVert, contentDescription = "More")
                            }
                            DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
                                DropdownMenuItem(
                                    text = { Text("Forget machine", color = MaterialTheme.colorScheme.error) },
                                    leadingIcon = { Icon(Icons.Outlined.Delete, null, tint = MaterialTheme.colorScheme.error) },
                                    onClick = {
                                        menu = false
                                        confirm.ask(
                                            title = "Forget “${data.host.name}”?",
                                            message = "Removes the pairing and its terminals. Run `optio local up` on the machine to pair it again.",
                                            confirmLabel = "Forget",
                                            destructive = true,
                                            onConfirm = onForget,
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
                data != null -> HostBody(data, navigator)
                page is LoadState.Failed ->
                    LazyColumn(Modifier.fillMaxSize()) { item { ErrorRow(error = page.error, what = "machine", retry = onRetry) } }
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp) }
            }
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun HostBody(
    data: HostPage,
    navigator: Navigator,
) {
    val host = data.host
    LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("host-page"), contentPadding = PaddingValues(bottom = Spacing.xl)) {
        item {
            DetailHeader(
                state = if (host.state == LocalHostState.ONLINE) "Online" else "Offline",
                tone = if (host.state == LocalHostState.ONLINE) Tone.SUCCESS else Tone.IDLE,
                line = metaText(host.platform, host.arch, host.daemonVersion?.let { "daemon $it" }),
                secondary = mono(host.hostname),
            )
        }
        item {
            GroupedSection(header = "Directories", footer = if (host.dirs.isEmpty()) "No directories exposed — `optio local add <dir>` on the machine." else null) {
                host.dirs.forEachIndexed { i, dir ->
                    DirLine(dir, Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m))
                    if (i < host.dirs.lastIndex) InsetDivider()
                }
            }
        }
        terminalsSection(data.terminals, navigator)
        if (data.automations.isNotEmpty()) {
            item {
                GroupedSection(header = "Automations") {
                    data.automations.forEachIndexed { i, bp ->
                        AutomationRow(automation = bp, triggers = emptyList(), hosts = listOf(host), onClick = { navigator.push(LocalAutomationRoute(bp.id)) })
                        if (i < data.automations.lastIndex) InsetDivider()
                    }
                }
            }
        }
    }
}

private fun LazyListScope.terminalsSection(
    terminals: List<LocalTerminal>,
    navigator: Navigator,
) {
    if (terminals.isEmpty()) {
        item {
            EmptyState(
                title = "No terminals on this machine",
                icon = Icons.Outlined.Terminal,
                message = "Start one from New work (Where: this machine), or let an automation spawn it.",
            )
        }
        return
    }
    HostTerminals.grouped(terminals).forEach { (group, members) ->
        item(key = "group-${group.name}") {
            GroupedSection(header = "${group.title} · ${members.size}") {
                members.forEachIndexed { i, t ->
                    TerminalRow(t, onClick = { navigator.push(LocalTerminalRoute(t.id)) })
                    if (i < members.lastIndex) InsetDivider()
                }
            }
        }
    }
}
