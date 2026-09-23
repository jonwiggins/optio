package dev.optio.core.data

import dev.optio.core.data.FakeOptioApi.Companion.GOOD
import dev.optio.core.data.FakeOptioApi.Companion.UNREACHABLE
import dev.optio.core.data.SessionStore.Phase
import dev.optio.core.network.ApiError
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout

/** SessionStore against fake servers: restore, add, switch, update, remove, the 401 re-check, clients, events. */
class SessionStoreTest {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val registry = ServerRegistry.inMemory()
    private val servers = mutableListOf<FakeOptioApi>()

    @AfterTest
    fun tearDown() {
        scope.cancel()
        servers.forEach { it.close() }
    }

    private fun fake(
        email: String = "dev@localhost",
        role: String = "member",
    ) = FakeOptioApi(email, role).also(servers::add)

    private fun session() = SessionStore(registry, scope, backgroundGrace = 50.milliseconds)

    /** A profile + token straight in the registry, as a previous launch left them. */
    private suspend fun paired(
        url: String,
        token: String = GOOD,
        id: String = url,
        addedAt: Instant = Instant.now(),
    ): ServerProfile {
        val profile = ServerProfile(id = id, name = id, url = url, color = ServerColor.SLATE, addedAt = addedAt)
        registry.upsert(profile)
        registry.setToken(token, profile.id)
        return profile
    }

    private suspend fun eventually(
        what: String,
        condition: () -> Boolean,
    ) {
        try {
            withTimeout(5_000) { while (!condition()) delay(20) }
        } catch (e: Exception) {
            throw AssertionError("timed out waiting for: $what", e)
        }
    }

    // region Restore

    @Test
    fun restoreWithNothingPairedSignsOut() =
        runBlocking<Unit> {
            val session = session()
            assertEquals(Phase.RESTORING, session.phase.value)
            session.restore()
            assertEquals(Phase.SIGNED_OUT, session.phase.value)
            assertFalse(session.api.isConfigured)
            assertFalse(session.events.isRunning)
        }

    @Test
    fun restoreVerifiesTheActiveServerAndStartsEvents() =
        runBlocking<Unit> {
            val api = fake(email = "ada@example.com", role = "admin")
            val profile = paired(api.url)
            val session = session()
            session.restore()
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals("ada@example.com", session.user.value?.email)
            assertTrue(session.user.value!!.isAdmin)
            assertEquals(profile.id, session.activeServer.value?.id)
            assertEquals(listOf(profile.id), session.servers.value.map { it.id })
            assertEquals(GOOD, session.api.token)
            assertEquals(api.url + "/", session.api.baseUrl.toString())
            assertTrue(session.events.isRunning)
            eventually("events connected") { session.events.connected.value }
            assertEquals(0, session.generation.value)
        }

    @Test
    fun restoreDropsARejectedServerAndTriesTheNext() =
        runBlocking<Unit> {
            val first = fake()
            val second = fake(email = "second@example.com")
            val rejected = paired(first.url, token = "optio_pat_revoked", addedAt = Instant.parse("2026-09-01T00:00:00Z"))
            val next = paired(second.url, addedAt = Instant.parse("2026-09-02T00:00:00Z"))
            registry.setActiveId(rejected.id)
            val session = session()
            session.restore()
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals(next.id, session.activeServer.value?.id)
            assertEquals("second@example.com", session.user.value?.email)
            assertNull(registry.profile(rejected.id))
            assertNull(registry.token(rejected.id))
        }

    @Test
    fun restoreSignsOutWhenTheOnlyServerRejectsItsToken() =
        runBlocking<Unit> {
            val api = fake()
            paired(api.url, token = "optio_pat_revoked")
            val session = session()
            session.restore()
            assertEquals(Phase.SIGNED_OUT, session.phase.value)
            assertEquals(emptyList(), registry.all())
        }

    @Test
    fun restoreStaysSignedInWhenTheServerIsUnreachable() =
        runBlocking<Unit> {
            val profile = paired(UNREACHABLE)
            val session = session()
            session.restore()
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertNull(session.user.value)
            assertEquals(profile.id, session.activeServer.value?.id)
            assertNotNull(registry.token(profile.id))
        }

    // endregion

    // region Add

    @Test
    fun addServerProbesBeforeStoringAnything() =
        runBlocking<Unit> {
            val api = fake()
            val session = session()
            session.restore()
            val error = assertFailsWith<ApiError> { session.addServer(api.url, "optio_pat_wrong") }
            assertTrue(error.isUnauthorized)
            assertEquals(Phase.SIGNED_OUT, session.phase.value)
            assertEquals(emptyList(), registry.all())

            val unreachable = assertFailsWith<ApiError> { session.addServer(UNREACHABLE, GOOD) }
            assertEquals(0, unreachable.status)
            assertFailsWith<IllegalArgumentException> { session.addServer("ftp://x", GOOD) }
        }

    @Test
    fun addServerPairsVerifiesAndActivates() =
        runBlocking<Unit> {
            val first = fake(email = "first@example.com")
            val second = fake(email = "second@example.com")
            val session = session()
            session.restore()

            val a = session.addServer(first.url, GOOD)
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals(1, session.generation.value)
            assertEquals(ServerColor.SLATE, a.color, "the first server is neutral")
            assertEquals(ServerProfile.defaultName(first.url), a.name)
            assertEquals("first@example.com", session.user.value?.email)
            assertEquals(first.url, registry.lastServerUrl())
            assertTrue(session.events.isRunning)

            val b = session.addServer(second.url, GOOD, name = "  Studio ", color = null)
            assertEquals(2, session.generation.value)
            assertEquals("Studio", b.name)
            assertEquals(ServerColor.BLUE, b.color, "the next unused hue")
            assertEquals(b.id, session.activeServer.value?.id)
            assertEquals(listOf(b.id, a.id), session.servers.value.map { it.id }, "active first")
            assertTrue(session.hasMultipleServers.value)
            assertEquals("second@example.com", session.user.value?.email)
        }

    @Test
    fun rePairingAnAddressReplacesItsTokenInsteadOfAddingATwin() =
        runBlocking<Unit> {
            val api = fake()
            api.validTokens = setOf(GOOD, "optio_pat_new")
            val session = session()
            session.restore()
            val original = session.addServer(api.url, GOOD)
            val again = session.addServer(api.url + "/", "optio_pat_new", name = "Renamed", color = ServerColor.ROSE)
            assertEquals(original.id, again.id)
            assertEquals(1, registry.all().size)
            assertEquals("optio_pat_new", registry.token(original.id))
            assertEquals("Renamed", again.name)
            assertEquals(ServerColor.ROSE, again.color)
            assertEquals("optio_pat_new", session.api.token)
        }

    // endregion

    // region Switch / update / remove

    @Test
    fun switchToRepointsTheClientAndRebuilds() =
        runBlocking<Unit> {
            val first = fake(email = "first@example.com")
            val second = fake(email = "second@example.com")
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            val b = session.addServer(second.url, GOOD)
            val generation = session.generation.value

            session.switchTo(a.id)
            assertEquals(generation + 1, session.generation.value)
            assertEquals(a.id, session.activeServer.value?.id)
            assertEquals(first.url + "/", session.api.baseUrl.toString())
            assertEquals("first@example.com", session.user.value?.email)
            assertFalse(session.switching.value)
            assertEquals(a.id, registry.activeId())
            assertTrue(session.events.isRunning)

            session.switchTo(a.id)
            session.switchTo("unknown")
            assertEquals(generation + 1, session.generation.value, "no-ops for the active server and unknown ids")
            assertEquals(listOf(a.id, b.id), session.servers.value.map { it.id })
        }

    @Test
    fun switchingToARejectedServerDropsItAndMovesOn() =
        runBlocking<Unit> {
            val first = fake(email = "first@example.com")
            val second = fake()
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            val b = session.addServer(second.url, GOOD)
            session.switchTo(a.id)

            second.validTokens = emptySet() // revoked on the server
            session.switchTo(b.id)
            assertEquals(a.id, session.activeServer.value?.id)
            assertEquals(listOf(a.id), session.servers.value.map { it.id })
            assertNull(registry.profile(b.id))
            eventually("user reloaded on the remaining server") { session.user.value?.email == "first@example.com" }
            assertFalse(session.switching.value)
        }

    @Test
    fun switchingToAnUnreachableServerStaysThere() =
        runBlocking<Unit> {
            val first = fake()
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            val far = paired(UNREACHABLE, id = "far")
            session.switchTo(far.id)
            assertEquals(far.id, session.activeServer.value?.id)
            assertNull(session.user.value)
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals(listOf(far.id, a.id), session.servers.value.map { it.id })
        }

    @Test
    fun updateServerRenamesRecoloursAndRepointsTheActiveOne() =
        runBlocking<Unit> {
            val first = fake()
            val second = fake()
            val moved = fake(email = "moved@example.com")
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            val b = session.addServer(second.url, GOOD)
            val generation = session.generation.value

            session.updateServer(a.copy(name = "Laptop", color = ServerColor.AMBER))
            assertEquals("Laptop", registry.profile(a.id)?.name)
            assertEquals(generation, session.generation.value, "editing another server doesn't rebuild")

            session.updateServer(b.copy(name = "Studio", workspaceId = "ws-2"))
            assertEquals("Studio", session.activeServer.value?.name)
            assertEquals("ws-2", session.workspaceId.value)
            assertEquals("ws-2", session.api.workspaceId)
            assertEquals(generation, session.generation.value)

            session.updateServer(session.activeServer.value!!.copy(url = moved.url))
            assertEquals(generation + 1, session.generation.value, "a new address rebuilds the shell")
            assertEquals(moved.url + "/", session.api.baseUrl.toString())
            eventually("user re-read from the new address") { session.user.value?.email == "moved@example.com" }
        }

    @Test
    fun removeServerMovesOnAndTheLastOneSignsOut() =
        runBlocking<Unit> {
            val first = fake(email = "first@example.com")
            val second = fake()
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            val b = session.addServer(second.url, GOOD)
            val generation = session.generation.value

            session.removeServer("not-there")
            assertEquals(generation, session.generation.value)

            session.removeServer(b.id)
            assertEquals(a.id, session.activeServer.value?.id)
            assertEquals(generation + 1, session.generation.value)
            assertNull(registry.token(b.id))
            eventually("user refreshed") { session.user.value?.email == "first@example.com" }

            session.signOut()
            assertEquals(Phase.SIGNED_OUT, session.phase.value)
            assertNull(session.activeServer.value)
            assertNull(session.user.value)
            assertFalse(session.api.isConfigured)
            assertFalse(session.events.isRunning)
            assertEquals(emptyList(), registry.all())
        }

    @Test
    fun forgettingAServerTellsRemovalListenersWhileItsTokenExists() =
        runBlocking<Unit> {
            val first = fake().apply { validTokens = setOf("optio_pat_first") }
            val second = fake()
            val session = session()
            session.restore()
            val a = session.addServer(first.url, "optio_pat_first")
            val b = session.addServer(second.url, GOOD)
            val heard = java.util.concurrent.CopyOnWriteArrayList<Pair<String, String?>>()
            registry.addRemovalListener { profile, token -> heard += profile.id to token }

            session.removeServer(b.id)
            session.signOut()
            assertEquals(listOf(b.id to GOOD, a.id to "optio_pat_first"), heard.toList())
        }

    // endregion

    // region 401 handling, workspace, clients

    @Test
    fun aUserScoped401KeepsTheServerWhileMeStillAnswers() =
        runBlocking<Unit> {
            val api = fake()
            api.routes["/api/workspaces"] = { FakeOptioApi.json("""{"error":"Not authenticated"}""", 401) }
            val session = session()
            session.restore()
            val a = session.addServer(api.url, GOOD)
            val meCalls = api.meRequests()

            assertFailsWith<ApiError> { session.api.get<Unit>("/api/workspaces") }
            eventually("/api/auth/me re-checked") { api.meRequests() > meCalls }
            delay(100)
            assertEquals(a.id, session.activeServer.value?.id, "an auth-disabled style 401 doesn't drop the server")
            assertEquals(Phase.SIGNED_IN, session.phase.value)

            api.validTokens = emptySet() // now the token really is dead
            assertFailsWith<ApiError> { session.api.get<Unit>("/api/workspaces") }
            eventually("server dropped") { session.phase.value == Phase.SIGNED_OUT }
            assertEquals(emptyList(), registry.all())
        }

    @Test
    fun theWorkspaceOverrideIsPersistedAndSent() =
        runBlocking<Unit> {
            val api = fake()
            val session = session()
            session.restore()
            val a = session.addServer(api.url, GOOD)
            session.setWorkspaceId("ws-7")
            assertEquals("ws-7", session.workspaceId.value)
            assertEquals("ws-7", registry.profile(a.id)?.workspaceId)
            session.refreshUser()
            assertEquals("ws-7", api.requests.last { it.url.encodedPath == "/api/auth/me" }.headers["x-workspace-id"])
            assertEquals("ws-7", session.user.value?.workspaceId)

            session.setWorkspaceId(null)
            assertNull(registry.profile(a.id)?.workspaceId)
            session.refreshUser()
            assertNull(api.requests.last { it.url.encodedPath == "/api/auth/me" }.headers["x-workspace-id"])
        }

    @Test
    fun clientsForOtherServers() =
        runBlocking<Unit> {
            // iOS testSharedFetchResolvesServer
            val first = fake()
            val second = fake()
            val session = session()
            session.restore()
            val a = session.addServer(first.url, GOOD)
            session.addServer(second.url, GOOD, name = "Studio")
            val b = session.servers.value.first { it.name == "Studio" }
            session.switchTo(a.id)

            assertEquals(second.url + "/", session.client(b.id)?.baseUrl.toString())
            assertEquals(GOOD, session.client(b.id)?.token)
            assertNull(session.client("missing"))
            assertEquals("Studio", session.resolveClient(b.id)?.server?.name)
            assertEquals(a.id, session.resolveClient(null)?.server?.id)
            assertEquals(a.id, session.resolveClient("missing")?.server?.id)
            assertEquals(listOf(a.id, b.id), session.clients().map { it.server.id })
            assertEquals("dev@localhost", session.client(b.id)!!.currentUser().email)
        }

    @Test
    fun devServersSeedThenRestore() =
        runBlocking<Unit> {
            val api = fake()
            val session = session()
            val seeded =
                session.applyDevServers(
                    mapOf(
                        DevServers.SERVER_URL to api.url,
                        DevServers.TOKEN to GOOD,
                        DevServers.SERVER_URL + "_2" to api.url,
                        DevServers.TOKEN + "_2" to GOOD,
                        DevServers.SERVER_NAME + "_2" to "Two",
                    ),
                )
            assertTrue(seeded)
            session.restore()
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals("dev-server", session.activeServer.value?.id)
            assertEquals(listOf("dev-server", "dev-server_2"), session.servers.value.map { it.id })

            // Seeding again while signed in and restoring rebuilds the shell.
            val generation = session.generation.value
            session.applyDevServers(mapOf(DevServers.SERVER_URL to api.url, DevServers.TOKEN to GOOD))
            session.restore()
            assertEquals(generation + 1, session.generation.value)
            assertEquals(listOf("dev-server"), session.servers.value.map { it.id })
        }

    // endregion

    // region Unreachable servers (no local network access)

    @Test
    fun anUnreachableServerSignsInAtOnceAndReconnectsLater() =
        runBlocking<Unit> {
            val api = fake(email = "lan@example.com")
            val profile = paired(api.url)
            var reachable = false
            val session = SessionStore(registry, scope, backgroundGrace = 50.milliseconds, reachable = { reachable })
            session.restore()
            assertEquals(Phase.SIGNED_IN, session.phase.value)
            assertEquals(profile.id, session.activeServer.value?.id)
            assertNull(session.user.value)
            assertEquals(0, api.meRequests(), "no probe that could only time out")

            reachable = true // the permission was granted
            session.reconnect()
            assertEquals("lan@example.com", session.user.value?.email)
        }

    @Test
    fun switchingToAnUnreachableServerSkipsTheProbe() =
        runBlocking<Unit> {
            val first = fake()
            val lan = fake()
            val session = SessionStore(registry, scope, reachable = { it.url != lan.url })
            session.restore()
            session.addServer(first.url, GOOD)
            val far = paired(lan.url, id = "lan")
            session.switchTo(far.id)
            assertEquals(far.id, session.activeServer.value?.id)
            assertNull(session.user.value)
            assertFalse(session.switching.value)
            assertEquals(0, lan.meRequests())
        }

    // endregion

    // region Events and lifecycle

    @Test
    fun eventsCloseInTheBackgroundUnlessRetained() =
        runBlocking<Unit> {
            val api = fake()
            val session = session()
            session.restore()
            session.addServer(api.url, GOOD)
            assertTrue(session.events.isRunning)

            session.appBackgrounded()
            eventually("events stopped after the grace period") { !session.events.isRunning }
            session.appForegrounded()
            assertTrue(session.events.isRunning)

            val hold = session.retainEvents()
            session.appBackgrounded()
            delay(200)
            assertTrue(session.events.isRunning, "a retained hub stays open in the background")
            hold.close()
            assertFalse(session.events.isRunning, "released in the background: closes")
            hold.close() // idempotent
            session.appForegrounded()
            assertTrue(session.events.isRunning)
        }

    // endregion
}
