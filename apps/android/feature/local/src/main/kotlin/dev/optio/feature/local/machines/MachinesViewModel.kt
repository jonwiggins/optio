package dev.optio.feature.local.machines

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalChangedEvent
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.EventHub
import dev.optio.core.network.on
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.load
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.api.deleteLocalBlueprint
import dev.optio.feature.local.api.deleteLocalHost
import dev.optio.feature.local.api.listLocalBlueprintTriggers
import dev.optio.feature.local.api.listLocalBlueprints
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.spawnLocalBlueprint
import dev.optio.feature.local.api.updateLocalBlueprint
import dev.optio.feature.local.api.LocalBlueprintBody
import dev.optio.feature.local.model.LocalPresentation
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch

/**
 * Library › Machines (iOS `MachinesView` + `LocalBlueprintsView`): the paired hosts, polled every
 * 30 s and nudged by `local:changed`, and the Local automations with their triggers.
 */
class MachinesViewModel(
    private val api: ApiClient,
    private val eventHub: EventHub? = null,
    private val pollInterval: Duration = 30.seconds,
) : ViewModel() {
    sealed interface Event {
        data class Toast(val message: String) : Event

        data class Failed(val error: Throwable, val verb: String) : Event

        data class Open(val route: LocalTerminalRoute) : Event
    }

    private val _hosts = MutableStateFlow<LoadState<List<LocalHost>>>(LoadState.Loading())

    /** Online first, then by name (iOS `sorted`). */
    val hosts: StateFlow<LoadState<List<LocalHost>>> = _hosts.asStateFlow()

    private val _automations = MutableStateFlow<LoadState<List<LocalBlueprint>>>(LoadState.Loading())
    val automations: StateFlow<LoadState<List<LocalBlueprint>>> = _automations.asStateFlow()

    private val _triggers = MutableStateFlow<Map<String, List<LocalTrigger>>>(emptyMap())

    /** Each automation's triggers, for the summaries under its row. */
    val triggers: StateFlow<Map<String, List<LocalTrigger>>> = _triggers.asStateFlow()

    private val eventChannel = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = eventChannel.receiveAsFlow()

    private var pollJob: Job? = null
    private var nudgeJob: Job? = null

    init {
        viewModelScope.launch { refresh() }
    }

    /** Hosts and automations (and their triggers); a failed refresh keeps what's on screen. */
    suspend fun refresh() {
        coroutineScope {
            launch { _hosts.load { sortHosts(api.listLocalHosts()) } }
            launch { refreshAutomations() }
        }
    }

    fun reload() {
        viewModelScope.launch { refresh() }
    }

    private suspend fun refreshAutomations() {
        val list = _automations.load { api.listLocalBlueprints() } ?: return
        refreshAutomationsTriggers(list)
    }

    private suspend fun refreshAutomationsTriggers(list: List<LocalBlueprint>) {
        val pairs =
            coroutineScope {
                list.map { bp ->
                    async {
                        bp.id to
                            try {
                                api.listLocalBlueprintTriggers(bp.id)
                            } catch (e: CancellationException) {
                                throw e
                            } catch (_: Exception) {
                                _triggers.value[bp.id].orEmpty()
                            }
                    }
                }.awaitAll()
            }
        _triggers.value = pairs.toMap()
    }

    private var attachedBefore = false

    /**
     * On screen: poll the hosts' online state and follow `local:changed` nudges. Coming back (from
     * an automation you edited, another tab) refreshes everything once.
     */
    fun attach() {
        if (attachedBefore) viewModelScope.launch { refreshQuietly() }
        attachedBefore = true
        if (pollJob == null) {
            pollJob =
                viewModelScope.launch {
                    while (isActive) {
                        delay(pollInterval)
                        refreshHostsQuietly()
                    }
                }
        }
        val hub = eventHub
        if (nudgeJob == null && hub != null) {
            nudgeJob = viewModelScope.launch { hub.on<LocalChangedEvent>().collect { refreshHostsQuietly() } }
        }
    }

    fun detach() {
        pollJob?.cancel()
        pollJob = null
        nudgeJob?.cancel()
        nudgeJob = null
    }

    private suspend fun refreshQuietly() {
        refreshHostsQuietly()
        try {
            val list = api.listLocalBlueprints()
            _automations.value = LoadState.Loaded(list)
            refreshAutomationsTriggers(list)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep what's on screen.
        }
    }

    private suspend fun refreshHostsQuietly() {
        try {
            _hosts.value = LoadState.Loaded(sortHosts(api.listLocalHosts()))
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep the last list (iOS only surfaces an error before the first load).
        }
    }

    // region Actions

    /** Unpairs [host] ("Forget machine"): its terminals go too. */
    fun forget(host: LocalHost) =
        act("forget the machine") {
            api.deleteLocalHost(host.id)
            _hosts.update { state -> state.value?.let { LoadState.Loaded(it.filterNot { h -> h.id == host.id }) } ?: state }
            eventChannel.send(Event.Toast("Forgot “${host.name}”"))
        }

    /** "Run now": spawns a terminal from [automation] and opens it. */
    fun spawn(automation: LocalBlueprint) =
        act("start the automation") {
            val terminal = api.spawnLocalBlueprint(automation.id)
            eventChannel.send(Event.Toast("Spawned “${terminal.title}” — ${LocalPresentation.stateLabel(terminal)}"))
            eventChannel.send(Event.Open(LocalTerminalRoute(terminal.id)))
        }

    fun setEnabled(
        automation: LocalBlueprint,
        enabled: Boolean,
    ) = act("update the automation") {
        val updated = api.updateLocalBlueprint(automation.id, LocalBlueprintBody(enabled = enabled))
        _automations.update { state -> state.value?.let { list -> LoadState.Loaded(list.map { if (it.id == updated.id) updated else it }) } ?: state }
    }

    fun delete(automation: LocalBlueprint) =
        act("delete the automation") {
            api.deleteLocalBlueprint(automation.id)
            _automations.update { state -> state.value?.let { list -> LoadState.Loaded(list.filterNot { it.id == automation.id }) } ?: state }
            _triggers.update { it - automation.id }
            eventChannel.send(Event.Toast("Automation deleted"))
        }

    private fun act(
        what: String,
        block: suspend () -> Unit,
    ) {
        viewModelScope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, what))
            }
        }
    }

    // endregion

    companion object {
        /** Online machines first, then by name (case-insensitive). */
        fun sortHosts(hosts: List<LocalHost>): List<LocalHost> =
            hosts.sortedWith(compareBy<LocalHost> { it.state != LocalHostState.ONLINE }.thenBy(String.CASE_INSENSITIVE_ORDER) { it.name })
    }
}
