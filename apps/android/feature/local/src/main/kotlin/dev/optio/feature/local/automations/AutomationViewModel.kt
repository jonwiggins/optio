package dev.optio.feature.local.automations

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.local.api.LocalBlueprintBody
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.api.createLocalBlueprintTrigger
import dev.optio.feature.local.api.deleteLocalBlueprint
import dev.optio.feature.local.api.deleteLocalBlueprintTrigger
import dev.optio.feature.local.api.getLocalBlueprint
import dev.optio.feature.local.api.listLocalBlueprintTriggers
import dev.optio.feature.local.api.listLocalHosts
import dev.optio.feature.local.api.listLocalTerminals
import dev.optio.feature.local.api.setLocalBlueprintTriggerEnabled
import dev.optio.feature.local.api.spawnLocalBlueprint
import dev.optio.feature.local.api.updateLocalBlueprint
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.TriggerKind
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
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
import kotlinx.serialization.json.JsonObject

/** An automation's page: the definition, its triggers, and every terminal it spawned (newest first). */
data class AutomationPage(
    val automation: LocalBlueprint,
    val triggers: List<LocalTrigger>,
    val runs: List<LocalTerminal>,
    val hosts: List<LocalHost>,
) {
    val host: LocalHost? get() = automation.hostId?.let { id -> hosts.firstOrNull { it.id == id } }

    /** Runs that wait on you (the web page's "Needs you" tile). */
    val needsYou: Int get() = runs.count { it.state == LocalTerminalState.RUNNING && it.attentionState == LocalAttentionState.NEEDS_YOU }

    val active: Int get() = runs.count { it.state == LocalTerminalState.RUNNING || it.state == LocalTerminalState.LAUNCHING }

    val totalCost: Double get() = runs.sumOf { it.costUsd?.toDoubleOrNull() ?: 0.0 }

    /** The soonest armed trigger's next firing. */
    val nextFire: Instant? get() = triggers.filter { it.enabled }.mapNotNull { it.nextFireAt }.minOrNull()

    val lastRun: Instant? get() = runs.firstOrNull()?.createdAt?.isoInstant()
}

/**
 * `LocalAutomationRoute` (iOS `LocalBlueprintDetailView`, web `/local/automations/:id`): loads the
 * automation, its triggers, its runs and the hosts; runs it, pauses it, deletes it, and edits its
 * triggers in place. Polls every 10 s while on screen so runs move.
 */
class AutomationViewModel(
    private val api: ApiClient,
    val automationId: String,
    private val pollInterval: Duration = 10.seconds,
) : ViewModel() {
    sealed interface Event {
        data class Toast(val message: String) : Event

        data class Failed(val error: Throwable, val verb: String) : Event

        data class Open(val route: LocalTerminalRoute) : Event

        data object Closed : Event
    }

    private val _page = MutableStateFlow<LoadState<AutomationPage>>(LoadState.Loading())
    val page: StateFlow<LoadState<AutomationPage>> = _page.asStateFlow()

    private val _busy = MutableStateFlow(false)
    val busy: StateFlow<Boolean> = _busy.asStateFlow()

    private val eventChannel = Channel<Event>(Channel.BUFFERED)
    val events: Flow<Event> = eventChannel.receiveAsFlow()

    private var pollJob: Job? = null

    init {
        viewModelScope.launch { refresh() }
    }

    suspend fun refresh(quiet: Boolean = false) {
        val before = _page.value.value
        if (!quiet) _page.value = LoadState.Loading(before)
        try {
            _page.value = LoadState.Loaded(fetch())
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            if (!quiet || before == null) _page.value = LoadState.Failed(e, before)
        }
    }

    private suspend fun fetch(): AutomationPage =
        coroutineScope {
            val automation = async { api.getLocalBlueprint(automationId) }
            val triggers = async { runCatching { api.listLocalBlueprintTriggers(automationId) }.getOrDefault(emptyList()) }
            val terminals = async { runCatching { api.listLocalTerminals() }.getOrDefault(emptyList()) }
            val hosts = async { runCatching { api.listLocalHosts() }.getOrDefault(emptyList()) }
            AutomationPage(
                automation = automation.await(),
                triggers = triggers.await(),
                runs = terminals.await().filter { it.blueprintId == automationId }.sortedByDescending { it.createdAt.isoInstant() ?: Instant.EPOCH },
                hosts = hosts.await(),
            )
        }

    fun reload() {
        viewModelScope.launch { refresh() }
    }

    private var attachedBefore = false

    /** On screen: poll so runs move; coming back (from the edit form) refreshes at once. */
    fun attach() {
        if (attachedBefore) viewModelScope.launch { refresh(quiet = true) }
        attachedBefore = true
        if (pollJob != null) return
        pollJob =
            viewModelScope.launch {
                while (isActive) {
                    delay(pollInterval)
                    refresh(quiet = true)
                }
            }
    }

    fun detach() {
        pollJob?.cancel()
        pollJob = null
    }

    // region Actions

    /** "Run now": a terminal from this automation (pending when it holds); opens it. */
    fun runNow() =
        act("start the automation") {
            val terminal = api.spawnLocalBlueprint(automationId)
            eventChannel.send(Event.Toast("Spawned “${terminal.title}” — ${LocalPresentation.stateLabel(terminal)}"))
            eventChannel.send(Event.Open(LocalTerminalRoute(terminal.id)))
            refresh(quiet = true)
        }

    fun setEnabled(enabled: Boolean) =
        act("update the automation") {
            val updated = api.updateLocalBlueprint(automationId, LocalBlueprintBody(enabled = enabled))
            _page.update { state -> state.value?.let { LoadState.Loaded(it.copy(automation = updated)) } ?: state }
        }

    fun delete() =
        act("delete the automation") {
            api.deleteLocalBlueprint(automationId)
            eventChannel.send(Event.Toast("Automation deleted"))
            eventChannel.send(Event.Closed)
        }

    /** Adds a trigger; returns once it's saved (the sheet closes then) or throws with the server's reason. */
    suspend fun addTrigger(
        kind: TriggerKind,
        config: JsonObject,
    ) {
        val trigger = api.createLocalBlueprintTrigger(automationId, kind.raw, config)
        _page.update { state -> state.value?.let { LoadState.Loaded(it.copy(triggers = it.triggers + trigger)) } ?: state }
        eventChannel.send(Event.Toast("Trigger added"))
    }

    fun setTriggerEnabled(
        trigger: LocalTrigger,
        enabled: Boolean,
    ) = act("update the trigger", busy = false) {
        val updated = api.setLocalBlueprintTriggerEnabled(automationId, trigger.id, enabled)
        _page.update { state ->
            state.value?.let { page -> LoadState.Loaded(page.copy(triggers = page.triggers.map { if (it.id == updated.id) updated else it })) } ?: state
        }
    }

    fun deleteTrigger(trigger: LocalTrigger) =
        act("delete the trigger", busy = false) {
            api.deleteLocalBlueprintTrigger(automationId, trigger.id)
            _page.update { state -> state.value?.let { page -> LoadState.Loaded(page.copy(triggers = page.triggers.filterNot { it.id == trigger.id })) } ?: state }
        }

    private fun act(
        what: String,
        busy: Boolean = true,
        block: suspend () -> Unit,
    ) {
        if (busy && _busy.value) return
        viewModelScope.launch {
            if (busy) _busy.value = true
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                eventChannel.send(Event.Failed(e, what))
            } finally {
                if (busy) _busy.value = false
            }
        }
    }

    // endregion
}
