package dev.optio.feature.more.servers

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.api.listWorkspaces
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull

/** Result of `GET /api/auth/me` against one server (iOS `ServerProbe`). */
data class ServerProbe(
    val state: State,
    /** Who the token signs in as ("Ada Admin", or the email). */
    val user: String? = null,
) {
    enum class State { ONLINE, UNAUTHORIZED, UNREACHABLE }

    val label: String
        get() = when (state) {
            State.ONLINE -> "Online"
            State.UNAUTHORIZED -> "Token rejected"
            State.UNREACHABLE -> "Unreachable"
        }

    val tone: Tone
        get() = when (state) {
            State.ONLINE -> Tone.SUCCESS
            State.UNAUTHORIZED -> Tone.DANGER
            State.UNREACHABLE -> Tone.IDLE
        }

    companion object {
        /** iOS probes with a 6 s timeout so one sleeping laptop doesn't stall the list. */
        val TIMEOUT: Duration = 6.seconds

        /** Probes [client] (null = no token stored: treated like a rejected one). */
        suspend fun run(
            client: ApiClient?,
            timeout: Duration = TIMEOUT,
        ): ServerProbe {
            if (client == null) return ServerProbe(State.UNAUTHORIZED)
            return try {
                val me = withTimeoutOrNull(timeout) { client.currentUser() } ?: return ServerProbe(State.UNREACHABLE)
                ServerProbe(State.ONLINE, me.displayName?.takeIf { it.isNotBlank() } ?: me.email)
            } catch (e: CancellationException) {
                throw e
            } catch (e: ApiError) {
                ServerProbe(if (e.isUnauthorized) State.UNAUTHORIZED else State.UNREACHABLE)
            }
        }
    }
}

/**
 * Paired servers (iOS `ServersView` + `ServerEditView`): every row probes its server so the list
 * doubles as a reachability check across laptops; edits and removals go through [SessionStore].
 */
class ServersViewModel(private val session: SessionStore) : ViewModel() {
    private val _probes = MutableStateFlow<Map<String, ServerProbe>>(emptyMap())

    /** The latest probe per server id; absent = still checking. */
    val probes: StateFlow<Map<String, ServerProbe>> = _probes.asStateFlow()

    private var probeJob: Job? = null

    /** Probes every server in [servers] at once (a pull-to-refresh awaits it). */
    suspend fun probeAll(servers: List<ServerProfile>) {
        coroutineScope {
            servers.map { server ->
                async {
                    val probe = ServerProbe.run(session.client(server.id))
                    _probes.update { it + (server.id to probe) }
                }
            }.awaitAll()
        }
    }

    /** Fire-and-forget [probeAll], replacing a run in flight (the server list changed). */
    fun reprobe(servers: List<ServerProfile>) {
        probeJob?.cancel()
        probeJob = viewModelScope.launch { probeAll(servers) }
    }

    /** Switches the whole app to [id] (runs in the session's scope; the shell rebuilds). */
    fun switchTo(id: String) {
        viewModelScope.launch { session.switchTo(id) }
    }

    /** Forgets [id] and its token (the active one hands over to the next server, or signs out). */
    fun forget(id: String) {
        viewModelScope.launch { session.removeServer(id) }
    }
}

/**
 * One server's editor (iOS `ServerEditView`): name, address, colour, and the workspace override
 * this app sends to it as `x-workspace-id` (picked from the workspaces the token can see there).
 */
class ServerEditViewModel(
    private val session: SessionStore,
    val serverId: String,
) : ViewModel() {
    private val _workspaces = MutableStateFlow<List<WorkspaceRow>?>(null)

    /** The server's workspaces; null while loading or when the server has none to offer (401 / unreachable). */
    val workspaces: StateFlow<List<WorkspaceRow>?> = _workspaces.asStateFlow()

    init {
        viewModelScope.launch { loadWorkspaces() }
    }

    suspend fun loadWorkspaces() {
        val client = session.client(serverId) ?: return
        // The picker offers the account's workspaces, whatever override is stored now.
        client.workspaceId = null
        _workspaces.value = try {
            withTimeoutOrNull(ServerProbe.TIMEOUT) { client.listWorkspaces() }
        } catch (e: CancellationException) {
            throw e
        } catch (_: ApiError) {
            null
        }
    }

    /** Saves [profile]; re-reads the user when the active server's workspace changed (roles follow it). */
    fun save(
        profile: ServerProfile,
        onSaved: () -> Unit,
    ) {
        viewModelScope.launch {
            val before = session.servers.value.firstOrNull { it.id == profile.id }
            session.updateServer(profile)
            val active = session.activeServer.value?.id == profile.id
            if (active && before?.workspaceId != profile.workspaceId) session.refreshUser()
            onSaved()
        }
    }

    fun forget(onForgotten: () -> Unit) {
        viewModelScope.launch {
            session.removeServer(serverId)
            onForgotten()
        }
    }
}
