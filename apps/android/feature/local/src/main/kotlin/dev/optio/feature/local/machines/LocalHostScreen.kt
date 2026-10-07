package dev.optio.feature.local.machines

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.Role
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.format.isoInstant
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
import dev.optio.core.model.LocalChangedEvent
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminal
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.EventHub
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.network.on
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
import dev.optio.feature.local.api.listLocalBlueprintTriggers
import dev.optio.feature.local.api.listLocalBlueprints
import dev.optio.feature.local.api.pinLocalTerminal
import dev.optio.feature.local.api.unpinLocalTerminal
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
import kotlinx.coroutines.awaitAll
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

/** Everything the machine page shows. */
data class HostPage(
    val host: LocalHost,
    val terminals: List<LocalTerminal>,
    val automations: List<LocalBlueprint>,
    /** Each automation's triggers; an automation whose triggers failed to load is missing. */
    val triggers: Map<String, List<LocalTrigger>> = emptyMap(),
)

/**
 * The terminals on one machine, in a stable order: pinned sessions first (in the same order among
 * themselves), then the session you last typed into, else the newest (`lastInteractedAt ??
 * createdAt` descending, then `createdAt`, then id). Attention state never reorders rows —
 * sessions flip between working and needs-you all the time, and a list that reshuffles under your
 * thumb can't be tapped. Waiting sessions show by their dot and label, and the header's "N need
 * you" jumps between them. The only moves are a pin / unpin, which you do, and live → Finished,
 * which happens once. The web's session rail orders the same way.
 */
object HostTerminals {
    enum class Group(val title: String) { LIVE("Sessions"), FINISHED("Finished") }

    fun group(t: LocalTerminal): Group = if (LocalPresentation.isDead(t)) Group.FINISHED else Group.LIVE

    private fun instant(iso: String?): Instant = iso?.isoInstant() ?: Instant.EPOCH

    /** The navigation order (see the object doc). */
    val order: Comparator<LocalTerminal> =
        compareByDescending<LocalTerminal> { LocalPresentation.isPinned(it) }
            .thenByDescending { instant(it.lastInteractedAt ?: it.createdAt) }
            .thenByDescending { instant(it.createdAt) }
            .thenBy { it.id }

    fun grouped(terminals: List<LocalTerminal>): List<Pair<Group, List<LocalTerminal>>> =
        Group.entries.mapNotNull { g ->
            val members = terminals.filter { group(it) == g }.sortedWith(order)
            if (members.isEmpty()) null else g to members
        }

    /** The rows top to bottom, as [grouped] lays them out. */
    fun ordered(terminals: List<LocalTerminal>): List<LocalTerminal> = grouped(terminals).flatMap { it.second }

    fun needsYouCount(terminals: List<LocalTerminal>): Int = terminals.count(LocalPresentation::waitsOnYou)

    /**
     * The waiting session after [afterId] in visual order, wrapping round; the first waiting one
     * when [afterId] is null or no longer listed. Null when nothing waits.
     */
    fun nextNeedsYou(
        terminals: List<LocalTerminal>,
        afterId: String?,
    ): LocalTerminal? {
        val rows = ordered(terminals)
        val start = rows.indexOfFirst { it.id == afterId }
        return (1..rows.size).asSequence().map { rows[(start + it).mod(rows.size)] }.firstOrNull(LocalPresentation::waitsOnYou)
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
            val mine = automations.await().filter { it.hostId == hostId }
            // The rows summarise their triggers, like the Machines list (QA: every row said "Runs when
            // you press Run", scheduled or not).
            val triggers =
                mine
                    .map { bp -> async { runCatching { bp.id to api.listLocalBlueprintTriggers(bp.id) }.getOrNull() } }
                    .awaitAll()
                    .filterNotNull()
                    .toMap()
            HostPage(host, terminals.await(), mine, triggers)
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
                    hub.on<LocalChangedEvent>()
                        .filter { it.hostId == hostId }
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

    /**
     * Pin / unpin a session: the row moves to the top (or back into the usual order) at once, and
     * the server's row replaces it when it answers — or the row is put back if it refuses.
     */
    fun togglePin(terminal: LocalTerminal) {
        val pinned = LocalPresentation.isPinned(terminal)
        replaceTerminal(terminal.id) { it.copy(pinnedAt = if (pinned) null else Instant.now().toString()) }
        viewModelScope.launch {
            try {
                val updated = if (pinned) api.unpinLocalTerminal(terminal.id) else api.pinLocalTerminal(terminal.id)
                replaceTerminal(terminal.id) { updated }
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                replaceTerminal(terminal.id) { terminal }
                eventChannel.send(Event.Failed(e, if (pinned) "unpin the session" else "pin the session"))
            }
        }
    }

    private fun replaceTerminal(
        id: String,
        transform: (LocalTerminal) -> LocalTerminal,
    ) {
        val state = _page.value
        val page = state.value ?: return
        val next = page.copy(terminals = page.terminals.map { if (it.id == id) transform(it) else it })
        _page.value =
            when (state) {
                is LoadState.Loading -> LoadState.Loading(next)
                is LoadState.Failed -> LoadState.Failed(state.error, next)
                else -> LoadState.Loaded(next)
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
        onTogglePin = vm::togglePin,
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
    onTogglePin: (LocalTerminal) -> Unit = {},
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
                data != null -> HostBody(data, navigator, canMutate, onTogglePin)
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
    canMutate: Boolean,
    onTogglePin: (LocalTerminal) -> Unit,
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
        terminalsSection(data.terminals, navigator, if (canMutate) onTogglePin else null)
        if (data.automations.isNotEmpty()) {
            item {
                GroupedSection(header = "Automations") {
                    data.automations.forEachIndexed { i, bp ->
                        AutomationRow(automation = bp, triggers = data.triggers[bp.id], hosts = listOf(host), onClick = { navigator.push(LocalAutomationRoute(bp.id)) })
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
    /** Null for viewers: no pin menu. */
    onTogglePin: ((LocalTerminal) -> Unit)?,
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
    val needsYou = HostTerminals.needsYouCount(terminals)
    HostTerminals.grouped(terminals).forEach { (group, members) ->
        item(key = "group-${group.name}") {
            Column {
                if (group == HostTerminals.Group.LIVE) {
                    LiveHeader(count = members.size, needsYou = needsYou, terminals = terminals, navigator = navigator)
                }
                GroupedSection(header = if (group == HostTerminals.Group.LIVE) null else "${group.title} · ${members.size}") {
                    members.forEachIndexed { i, t ->
                        TerminalRow(
                            t,
                            onClick = { navigator.push(LocalTerminalRoute(t.id)) },
                            onTogglePin = onTogglePin?.let { toggle -> { toggle(t) } },
                        )
                        if (i < members.lastIndex) InsetDivider()
                    }
                }
            }
        }
    }
}

/**
 * "Sessions · N" and, while any wait on you, a tappable "N need you" that opens the next waiting
 * session in list order (cycling on each tap), so the rows themselves never have to move.
 */
@Composable
private fun LiveHeader(
    count: Int,
    needsYou: Int,
    terminals: List<LocalTerminal>,
    navigator: Navigator,
) {
    var lastJumped by rememberSaveable { mutableStateOf<String?>(null) }
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l * 2, end = Spacing.l, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        SectionHeader(
            "${HostTerminals.Group.LIVE.title} · $count",
            modifier = Modifier.weight(1f),
            contentPadding = PaddingValues(0.dp),
        )
        if (needsYou > 0) {
            Row(
                Modifier
                    .clip(RoundedCornerShape(50))
                    .clickable(role = Role.Button) {
                        HostTerminals.nextNeedsYou(terminals, lastJumped)?.let {
                            lastJumped = it.id
                            navigator.push(LocalTerminalRoute(it.id))
                        }
                    }
                    .padding(horizontal = Spacing.s, vertical = Spacing.xs)
                    .testTag("next-needs-you"),
                horizontalArrangement = Arrangement.spacedBy(5.dp),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                StateDot(Tone.ACCENT, size = 6.dp, pulse = false)
                Text("$needsYou need${if (needsYou == 1) "s" else ""} you", style = OptioTheme.type.footnote.semibold(), color = Tone.ACCENT.textColor)
            }
        }
    }
}
