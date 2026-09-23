package dev.optio.feature.more

import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.feature.more.servers.ServerDraft
import dev.optio.feature.more.servers.ServerEditViewModel
import dev.optio.feature.more.servers.ServerProbe
import dev.optio.feature.more.servers.ServersViewModel
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.withTimeout
import org.junit.Rule

/**
 * Paired servers against real fake servers and a real [SessionStore]: reachability probes
 * (online / token rejected / unreachable), switching, forgetting, and the edit screen's workspace
 * override. Real time throughout (the probes time out on the wall clock).
 */
@OptIn(ExperimentalCoroutinesApi::class)
class ServersViewModelTest {
    @get:Rule(order = 0)
    val main = MainDispatcherRule(UnconfinedTestDispatcher())

    @get:Rule(order = 1)
    val vms = ViewModelsRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val registry = ServerRegistry.inMemory()
    private val session = SessionStore(registry, scope)
    private val fakes = mutableListOf<FakeOptioServer>()

    @AfterTest
    fun tearDown() {
        session.events.stop()
        scope.cancel()
        fakes.forEach { it.close() }
    }

    /** A server whose `/api/auth/me` accepts [TOKEN] as [name]. */
    private fun server(
        name: String,
        email: String = "$name@example.com".lowercase(),
    ): FakeOptioServer = FakeOptioServer().start().also { fake ->
        fakes += fake
        fake.get("/api/auth/me") { req ->
            if (req.header("Authorization") == "Bearer $TOKEN") {
                FakeResponse.json(
                    """{"user":{"id":"u-$name","email":"$email","displayName":"$name","workspaceId":"ws-1","workspaceRole":"admin"},"authDisabled":false}""",
                )
            } else {
                FakeResponse.error(401, "Invalid or expired session")
            }
        }
        fake.webSocket("/ws/events")
    }

    private suspend fun pair(
        id: String,
        url: String,
        token: String = TOKEN,
        minutesAgo: Long = 0,
    ): ServerProfile {
        val profile = ServerProfile(id = id, name = id, url = url, color = ServerColor.SLATE, addedAt = Instant.now().minusSeconds(600 - minutesAgo * 60))
        registry.upsert(profile)
        registry.setToken(token, id)
        return profile
    }

    private suspend fun eventually(
        what: String,
        condition: suspend () -> Boolean,
    ) {
        try {
            withTimeout(5_000) { while (!condition()) delay(20) }
        } catch (e: Exception) {
            throw AssertionError("timed out waiting for: $what", e)
        }
    }

    @Test
    fun probesTellOnlineRejectedAndUnreachableApart() = runBlocking {
        val laptop = server("Ada Admin")
        val studio = server("Studio")
        val gone = FakeOptioServer().start().also { it.close() } // nothing listens there any more
        pair("laptop", laptop.baseUrl, minutesAgo = 3)
        pair("studio", studio.baseUrl, token = "optio_pat_revoked", minutesAgo = 2)
        pair("gone", gone.baseUrl, minutesAgo = 1)
        session.restore()
        val vm = vms.of { ServersViewModel(session) }

        vm.probeAll(session.servers.value)
        val probes = vm.probes.value
        assertEquals(ServerProbe(ServerProbe.State.ONLINE, "Ada Admin"), probes["laptop"])
        assertEquals(ServerProbe.State.UNAUTHORIZED, probes["studio"]?.state)
        assertEquals(ServerProbe.State.UNREACHABLE, probes["gone"]?.state)
        assertEquals("Token rejected", probes["studio"]?.label)
        assertEquals("Unreachable", probes["gone"]?.label)
        // Probes use their own clients: a rejected token on another server never drops it.
        assertEquals(3, session.servers.value.size)
    }

    @Test
    fun aSlowServerTimesOutAsUnreachable() = runBlocking {
        val slow = FakeOptioServer().start().also { fakes += it }
        slow.get("/api/auth/me") { FakeResponse.json("""{"user":{"id":"u"}}""").delayed(2_000) }
        val probe = ServerProbe.run(ApiClient(slow.baseUrl, TOKEN), timeout = 200.milliseconds)
        assertEquals(ServerProbe.State.UNREACHABLE, probe.state)
        assertEquals(ServerProbe(ServerProbe.State.UNAUTHORIZED), ServerProbe.run(null), "no token stored")
    }

    @Test
    fun switchingAndForgetting() = runBlocking {
        val laptop = server("Laptop")
        val studio = server("Studio")
        pair("laptop", laptop.baseUrl, minutesAgo = 2)
        pair("studio", studio.baseUrl, minutesAgo = 1)
        session.restore()
        assertEquals("laptop", session.activeServer.value?.id)
        val generation = session.generation.value
        val vm = vms.of { ServersViewModel(session) }

        vm.switchTo("studio")
        eventually("switched") { session.activeServer.value?.id == "studio" }
        assertTrue(session.generation.value > generation, "the shell rebuilds for the new server")

        vm.forget("laptop")
        eventually("forgotten") { session.servers.value.map { it.id } == listOf("studio") }
        assertNull(registry.token("laptop"), "its token is gone from this phone")
    }

    @Test
    fun editLoadsTheServersWorkspacesWithoutTheOverride() = runBlocking {
        val laptop = server("Laptop")
        laptop.get("/api/workspaces") { FakeResponse.fixture("workspaces.json") }
        val profile = pair("laptop", laptop.baseUrl).copy(workspaceId = "stale-override")
        registry.upsert(profile)
        session.restore()
        val vm = vms.of { ServerEditViewModel(session, "laptop") }
        eventually("workspaces") { vm.workspaces.value != null }
        assertEquals(listOf("Android DevLab", "Side project"), vm.workspaces.value!!.map { it.displayName })
        assertNull(laptop.lastRequest("GET", "/api/workspaces")!!.header("x-workspace-id"), "the picker lists the account's workspaces")
    }

    @Test
    fun editWithoutWorkspacesLeavesThePickerEmpty() = runBlocking {
        val laptop = server("Laptop")
        laptop.get("/api/workspaces") { FakeResponse.error(401, "Authentication required") }
        pair("laptop", laptop.baseUrl)
        session.restore()
        val vm = vms.of { ServerEditViewModel(session, "laptop") }
        eventually("request") { laptop.count("GET", "/api/workspaces") == 1 }
        delay(100)
        assertNull(vm.workspaces.value)
    }

    @Test
    fun savingANewWorkspaceOverrideReReadsTheUser() = runBlocking {
        val laptop = server("Laptop")
        val profile = pair("laptop", laptop.baseUrl)
        session.restore()
        val vm = vms.of { ServerEditViewModel(session, "laptop") }
        laptop.clearRequests()

        var saved = false
        val draft = ServerDraft.of(profile).copy(name = "MacBook", color = ServerColor.AMBER, workspaceId = "ws-2")
        vm.save(draft.applyTo(profile)) { saved = true }
        eventually("saved") { saved }
        val stored = assertNotNull(registry.profile("laptop"))
        assertEquals("MacBook", stored.name)
        assertEquals(ServerColor.AMBER, stored.color)
        assertEquals("ws-2", stored.workspaceId)
        assertEquals("ws-2", session.workspaceId.value)
        eventually("user re-read") { laptop.lastRequest("GET", "/api/auth/me")?.header("x-workspace-id") == "ws-2" }
    }

    private companion object {
        const val TOKEN = "optio_pat_devlab"
    }
}
