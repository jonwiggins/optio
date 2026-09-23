package dev.optio.core.data

import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.EventHub
import dev.optio.core.network.OptioHttp
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharingStarted
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.stateIn
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import okhttp3.OkHttpClient

/**
 * Owns the paired servers, which one is active, and the current user on it (port of iOS
 * `SessionStore`).
 *
 * Profiles and tokens persist through [registry]. The one [api] / [events] pair is re-pointed on
 * every switch, and [generation] bumps so the signed-in shell (keyed on it) rebuilds with fresh
 * screen state for the new server.
 *
 * Every mutating call runs in the session's own [scope], so it completes even when the screen that
 * started it goes away (a server switch disposes the whole shell), and state changes are
 * serialized. The flows are safe to collect from any thread.
 *
 * ```
 * val session = LocalSessionStore.current
 * val servers by session.servers.collectAsStateWithLifecycle()
 * val scope = rememberCoroutineScope()
 * Button(onClick = { scope.launch { session.switchTo(server.id) } }) { … }
 * ```
 */
class SessionStore(
    /** Where profiles and tokens persist. */
    val registry: ServerRegistry,
    private val scope: CoroutineScope,
    private val httpClient: OkHttpClient = OptioHttp.client,
    eventHubFactory: (ApiClient) -> EventHub = { EventHub(it) },
    private val backgroundGrace: Duration = BACKGROUND_GRACE,
    /**
     * False when [ServerProfile] cannot be reached at all right now (the app passes "a local server
     * without the local network permission", `LocalNetworkAccess`): restore and switch then treat it
     * as unreachable at once instead of waiting out a connect timeout. Call [reconnect] once it can.
     */
    private val reachable: suspend (ServerProfile) -> Boolean = { true },
) {
    enum class Phase { RESTORING, SIGNED_OUT, SIGNED_IN }

    private val _phase = MutableStateFlow(Phase.RESTORING)
    private val _user = MutableStateFlow<CurrentUser?>(null)
    private val _servers = MutableStateFlow<List<ServerProfile>>(emptyList())
    private val _activeServer = MutableStateFlow<ServerProfile?>(null)
    private val _generation = MutableStateFlow(0)
    private val _switching = MutableStateFlow(false)
    private val _workspaceId = MutableStateFlow<String?>(null)

    /** Restoring from disk at launch → signed out (no usable server) or signed in. */
    val phase: StateFlow<Phase> = _phase.asStateFlow()

    /** The user on the active server; null while unknown (just switched, server unreachable). */
    val user: StateFlow<CurrentUser?> = _user.asStateFlow()

    /** Paired servers with a usable token, active first, then in the order they were added. */
    val servers: StateFlow<List<ServerProfile>> = _servers.asStateFlow()

    /** The server [api] talks to. */
    val activeServer: StateFlow<ServerProfile?> = _activeServer.asStateFlow()

    /** Incremented on every server switch; the signed-in shell is keyed on it. */
    val generation: StateFlow<Int> = _generation.asStateFlow()

    /** True between a switch starting and the new server answering `/api/auth/me`. */
    val switching: StateFlow<Boolean> = _switching.asStateFlow()

    /** Workspace override sent as `x-workspace-id`; null = the user's default workspace. */
    val workspaceId: StateFlow<String?> = _workspaceId.asStateFlow()

    /** More than one server is paired (the switcher shows on every hub). */
    val hasMultipleServers: StateFlow<Boolean> =
        _servers.map { it.size > 1 }.stateIn(scope, SharingStarted.Eagerly, false)

    /** The one client for the active server. Provided to screens as `LocalApiClient`. */
    val api: ApiClient = ApiClient(httpClient)

    /** App-wide `/ws/events` fan-out; runs while signed in and in the foreground. `LocalEventHub`. */
    val events: EventHub = eventHubFactory(api)

    private val mutex = Mutex()
    private val verifyingToken = AtomicBoolean(false)
    private val switchesInFlight = AtomicInteger(0)
    private val lifecycleLock = Any()
    private var foreground = true
    private var backgroundStop: Job? = null
    private val eventHolds = AtomicInteger(0)

    init {
        // A single 401 from a user-scoped route is not proof the token is dead (auth-disabled dev
        // servers 401 on a few of them). Re-check identity and only drop the server when
        // `/api/auth/me` itself rejects the token.
        api.onUnauthorized = { scope.launch { verifyTokenStillValid() } }
    }

    // region Restore

    /**
     * Restores the paired servers from disk, activates the last used one and verifies it. A
     * rejected token drops that server and tries the next; an unreachable server stays signed in
     * with its cached credentials so the user can retry once the tailnet is up.
     */
    suspend fun restore(): Unit =
        inSession {
            mutex.withLock {
                if (_phase.value != Phase.RESTORING) {
                    // Restoring again (debug re-seeding): leave the old shell behind.
                    events.stop()
                    _user.value = null
                    _phase.value = Phase.RESTORING
                    _generation.value += 1
                }
            }
            while (true) {
                val profile =
                    mutex.withLock {
                        reloadRegistry()
                        val candidate =
                            registry.active()?.takeIf { registry.token(it.id) != null }
                                ?: registry.configured().firstOrNull()
                        val token = candidate?.let { registry.token(it.id) }
                        if (candidate == null || token == null) {
                            signOutLocked()
                            null
                        } else {
                            activate(candidate, token)
                            candidate
                        }
                    } ?: return@inSession
                if (!reachable(profile)) {
                    // Known to be unreachable (no local network access): signed in, user unknown.
                    mutex.withLock { _phase.value = Phase.SIGNED_IN }
                    break
                }
                val verified =
                    try {
                        val me = api.currentUser()
                        mutex.withLock {
                            _user.value = me
                            _phase.value = Phase.SIGNED_IN
                        }
                        true
                    } catch (e: ApiError) {
                        if (e.isUnauthorized) {
                            mutex.withLock { registry.remove(profile.id) }
                            false
                        } else {
                            // Server unreachable: stay signed in with cached credentials.
                            mutex.withLock { _phase.value = Phase.SIGNED_IN }
                            true
                        }
                    }
                if (verified) break
            }
            startEventsIfWanted()
        }

    // endregion

    // region Add / switch / update / remove

    /**
     * Verifies [token] against [url] (`GET /api/auth/me` on a throwaway client), stores the
     * profile and makes it active. The first server signs the phone in; later ones switch to the
     * new one. Pairing an address that is already paired replaces its token (and its name/colour
     * when given) instead of adding a twin.
     *
     * @throws ApiError the server rejected the token (401), could not be reached (status 0), …
     * @throws IllegalArgumentException [url] is not an http(s) address.
     * @throws IllegalStateException the token could not be stored securely.
     */
    suspend fun addServer(
        url: String,
        token: String,
        name: String? = null,
        color: ServerColor? = null,
    ): ServerProfile =
        inSession {
            val address = requireNotNull(ServerProfile.normalizeUrl(url)) { "Not a server address: $url" }
            val me = ApiClient(address, token, null, httpClient).currentUser()
            mutex.withLock {
                val paired = registry.configured()
                val existing = paired.firstOrNull { ServerProfile.sameUrl(it.url, address) }
                val trimmedName = name?.trim()?.takeIf { it.isNotEmpty() }
                var profile =
                    existing ?: ServerProfile(
                        name = trimmedName ?: ServerProfile.defaultName(address),
                        url = address,
                        color = color ?: ServerColor.next(paired.map { it.color }),
                    )
                if (trimmedName != null) profile = profile.copy(name = trimmedName)
                if (color != null) profile = profile.copy(color = color)
                check(registry.setToken(token, profile.id)) { "Couldn't store the token securely." }
                registry.upsert(profile)
                registry.setLastServerUrl(address)

                events.stop()
                activate(profile, token)
                _user.value = me
                _phase.value = Phase.SIGNED_IN
                _generation.value += 1
                startEventsIfWanted()
                profile
            }
        }

    /** Switches the whole app to another paired server. No-op for the active one or an unknown id. */
    suspend fun switchTo(id: String): Unit =
        inSession {
            val generation =
                mutex.withLock {
                    if (id == _activeServer.value?.id) return@withLock null
                    val profile = registry.profile(id) ?: return@withLock null
                    val token = registry.token(id) ?: return@withLock null
                    switchesInFlight.incrementAndGet()
                    _switching.value = true
                    events.stop()
                    _user.value = null
                    activate(profile, token)
                    _generation.value += 1
                    startEventsIfWanted()
                    _generation.value
                } ?: return@inSession
            try {
                val profile = _activeServer.value
                if (profile != null && !reachable(profile)) return@inSession
                val me = api.currentUser()
                mutex.withLock { if (_generation.value == generation) _user.value = me }
            } catch (e: ApiError) {
                if (e.isUnauthorized) {
                    mutex.withLock { if (_activeServer.value?.id == id) removeLocked(id) }
                }
                // Unreachable: stay on it; screens show their own retry.
            } finally {
                if (switchesInFlight.decrementAndGet() == 0) _switching.value = false
            }
        }

    /**
     * Renames / recolours a server, edits its address or workspace override. A new address on the
     * active server re-points the client and rebuilds the shell.
     */
    suspend fun updateServer(profile: ServerProfile): Unit =
        inSession {
            mutex.withLock {
                val active = _activeServer.value
                val isActive = profile.id == active?.id
                val addressChanged = isActive && !ServerProfile.sameUrl(profile.url, active.url)
                registry.upsert(profile)
                reloadRegistry()
                if (!isActive) return@withLock
                val token = if (addressChanged) registry.token(profile.id) else null
                if (token != null) {
                    events.stop()
                    activate(profile, token)
                    _generation.value += 1
                    startEventsIfWanted()
                    scope.launch { refreshUser() }
                } else {
                    _activeServer.value = profile
                    if (_workspaceId.value != profile.workspaceId) {
                        _workspaceId.value = profile.workspaceId
                        api.workspaceId = profile.workspaceId
                    }
                }
            }
        }

    /**
     * Forgets a server and its token. Removing the active one moves to the next paired server;
     * removing the last one signs the phone out.
     */
    suspend fun removeServer(id: String): Unit = inSession { mutex.withLock { removeLocked(id) } }

    /** Forgets the active server (the "Sign out" action on the account card). */
    suspend fun signOut() {
        val id = _activeServer.value?.id ?: return
        removeServer(id)
    }

    /** Re-reads the user on the active server (e.g. after a workspace switch). Keeps the last one on failure. */
    suspend fun refreshUser() {
        val generation = _generation.value
        try {
            val me = api.currentUser()
            if (_generation.value == generation) _user.value = me
        } catch (_: ApiError) {
            // Unreachable, or 401 (the onUnauthorized re-check decides whether the server goes).
        }
    }

    /**
     * The active server became reachable (e.g. local network access was just granted): reopens the
     * event socket at once instead of after its pending connect times out, and re-reads the user.
     */
    suspend fun reconnect() {
        if (_phase.value != Phase.SIGNED_IN) return
        if (events.isRunning) events.restart()
        refreshUser()
    }

    /** Sets the workspace override for the active server (sent as `x-workspace-id`) and persists it. */
    suspend fun setWorkspaceId(id: String?): Unit =
        inSession {
            mutex.withLock {
                _workspaceId.value = id
                api.workspaceId = id
                val profile = _activeServer.value
                if (profile != null && profile.workspaceId != id) {
                    registry.upsert(profile.copy(workspaceId = id))
                    reloadRegistry()
                }
            }
        }

    // endregion

    // region Other servers

    /**
     * A throwaway client for another paired server (notification actions, widgets, cross-server
     * probes); null when [serverId] is unknown or has no token. Use [api] for the active server.
     */
    suspend fun client(serverId: String): ApiClient? {
        val profile = registry.profile(serverId) ?: return null
        val token = registry.token(profile.id) ?: return null
        return ApiClient(profile.url, token, profile.workspaceId, httpClient)
    }

    /** One client per configured server, active first (iOS `SharedFetch.allServers`). */
    suspend fun clients(): List<ServerClient> =
        registry.configured().mapNotNull { profile ->
            registry.token(profile.id)?.let { ServerClient(profile, ApiClient(profile.url, it, profile.workspaceId, httpClient)) }
        }

    /** The client for [serverId], falling back to the active server (iOS `SharedFetch.resolve`). */
    suspend fun resolveClient(serverId: String?): ServerClient? {
        if (serverId != null) {
            val profile = registry.profile(serverId)
            val token = profile?.let { registry.token(it.id) }
            if (profile != null && token != null) return ServerClient(profile, ApiClient(profile.url, token, profile.workspaceId, httpClient))
        }
        val active = registry.active() ?: return null
        val token = registry.token(active.id) ?: return null
        return ServerClient(active, ApiClient(active.url, token, active.workspaceId, httpClient))
    }

    // endregion

    // region Events and app lifecycle

    /** The app came to the foreground: (re)start `/ws/events` when signed in. */
    fun appForegrounded() {
        synchronized(lifecycleLock) {
            foreground = true
            backgroundStop?.cancel()
            backgroundStop = null
        }
        if (_phase.value == Phase.SIGNED_IN) events.start()
    }

    /** The app went to the background: `/ws/events` closes after a grace period unless retained. */
    fun appBackgrounded() {
        synchronized(lifecycleLock) {
            foreground = false
            backgroundStop?.cancel()
            backgroundStop =
                scope.launch {
                    delay(backgroundGrace)
                    val stop = synchronized(lifecycleLock) { !foreground && eventHolds.get() == 0 }
                    if (stop) events.stop()
                }
        }
    }

    /**
     * Keeps `/ws/events` open while the app is in the background (e.g. a "Keep watching"
     * foreground service); close the handle to release it.
     */
    fun retainEvents(): AutoCloseable {
        eventHolds.incrementAndGet()
        if (_phase.value == Phase.SIGNED_IN) events.start()
        val released = AtomicBoolean(false)
        return AutoCloseable {
            if (released.compareAndSet(false, true) && eventHolds.decrementAndGet() == 0) {
                val stop = synchronized(lifecycleLock) { !foreground }
                if (stop) events.stop()
            }
        }
    }

    private fun startEventsIfWanted() {
        val wanted = synchronized(lifecycleLock) { foreground } || eventHolds.get() > 0
        if (wanted && _phase.value == Phase.SIGNED_IN) events.start()
    }

    // endregion

    // region Debug seeding

    /**
     * DEBUG builds only (the app calls this under `BuildConfig.DEBUG`): replaces the paired servers
     * with the ones in launch-intent [extras] (`OPTIO_DEV_SERVER_URL[_n]`, `OPTIO_DEV_TOKEN[_n]`,
     * `OPTIO_DEV_SERVER_NAME[_n]`; ids `dev-server`, `dev-server_2`, …) and makes the first
     * active. Call [restore] afterwards. False when [extras] name no server.
     */
    suspend fun applyDevServers(extras: Map<String, String>): Boolean = inSession { mutex.withLock { DevServers.seed(registry, extras) } }

    // endregion

    // region Internals

    /** Points the shared client at [profile] without touching [phase]. Call under [mutex]. */
    private suspend fun activate(
        profile: ServerProfile,
        token: String,
    ) {
        registry.setActiveId(profile.id)
        api.configure(profile.url, token, profile.workspaceId)
        _workspaceId.value = profile.workspaceId
        reloadRegistry()
        _activeServer.value = profile
    }

    /** Call under [mutex]. */
    private suspend fun reloadRegistry() {
        _servers.value = registry.configured()
        _activeServer.value = registry.active()
    }

    /** Call under [mutex]. */
    private suspend fun removeLocked(id: String) {
        val wasActive = id == _activeServer.value?.id
        registry.remove(id)
        reloadRegistry()
        if (!wasActive) return
        events.stop()
        _user.value = null
        val next = registry.configured().firstOrNull()
        val token = next?.let { registry.token(it.id) }
        if (next != null && token != null) {
            activate(next, token)
            _generation.value += 1
            startEventsIfWanted()
            scope.launch { refreshUser() }
        } else {
            signOutLocked()
        }
    }

    /** Call under [mutex]. */
    private fun signOutLocked() {
        events.stop()
        api.configure(null, null, null)
        _activeServer.value = null
        _workspaceId.value = null
        _user.value = null
        _phase.value = Phase.SIGNED_OUT
    }

    private suspend fun verifyTokenStillValid() {
        if (_phase.value != Phase.SIGNED_IN) return
        if (!verifyingToken.compareAndSet(false, true)) return
        try {
            val serverId = _activeServer.value?.id ?: return
            val generation = _generation.value
            try {
                val me = api.currentUser()
                if (_generation.value == generation) _user.value = me
            } catch (e: ApiError) {
                if (e.isUnauthorized) {
                    inSession { mutex.withLock { if (_activeServer.value?.id == serverId) removeLocked(serverId) } }
                }
                // Network or other failure: keep the session.
            }
        } finally {
            verifyingToken.set(false)
        }
    }

    /** Runs [block] in the session scope: it finishes even if the caller is cancelled. */
    private suspend fun <T> inSession(block: suspend () -> T): T = scope.async { block() }.await()

    // endregion

    companion object {
        /** How long `/ws/events` stays open after the app leaves the foreground. */
        val BACKGROUND_GRACE: Duration = 60.seconds
    }
}

/** A paired server and a client for it ([SessionStore.clients]). */
data class ServerClient(
    val server: ServerProfile,
    val api: ApiClient,
)
