package dev.optio.feature.overview

import dev.optio.core.network.ApiClient
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import java.net.ServerSocket
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** Another server's Local work: one agent terminal waiting on you, one working, one host online. */
internal fun serveLocalWork(server: FakeOptioServer) {
    server.json("/api/local/hosts", """{"hosts":[{"id":"h1","name":"Studio mac","state":"online"}]}""")
    server.json(
        "/api/local/terminals",
        """{"terminals":[
            {"id":"t1","title":"Fix login","dir":"/Users/dev/app","state":"running","hostId":"h1",
             "attentionState":"needs_you","attentionReason":"stop","spec":{"kind":"agent","agent":"claude-code"}},
            {"id":"t2","title":"Refactor","dir":"/Users/dev/app","state":"running","hostId":"h1",
             "attentionState":"working","spec":{"kind":"agent","agent":"codex"}}]}""",
    )
}

/** Other servers' glances (iOS `ServerGlance.load` / `OtherServersModel`). */
@OptIn(ExperimentalCoroutinesApi::class)
class ServerGlanceTest {
    private val server = FakeOptioServer().start()
    private val profile = OverviewSeed.studio

    @AfterTest
    fun tearDown() = server.close()

    private fun client() = ServerGlances.withGlanceTimeout(server.client())

    @Test
    fun anOnlineServerReportsItsTaskCounts() = runBlocking<Unit> {
        server.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        val glance = ServerGlances.load(profile, client(), clock = OverviewSeed.clock)
        assertEquals(ServerGlance.State.ONLINE, glance.state)
        assertEquals(1, glance.running)
        assertEquals(1, glance.needsYou)
        assertEquals(1, glance.failed)
        assertEquals(OverviewSeed.clock.instant(), glance.asOf)
        assertEquals(0, server.count("GET", "/api/auth/me"), "no probe when the stats answer")
    }

    @Test
    fun theNeedsYouSnapshotAddsLocalWorkAndHosts() = runBlocking<Unit> {
        server.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        val glance = ServerGlances.load(profile, client(), snapshot = { GlanceCounts(needsYou = 2, running = 1, hostsOnline = 1, hostsTotal = 2) })
        assertEquals(3, glance.needsYou)
        assertEquals(2, glance.running)
        assertEquals(1, glance.hostsOnline)
        assertEquals(2, glance.hostsTotal)
    }

    @Test
    fun theDefaultSnapshotIsTheServersNeedsYouSnapshot() = runBlocking<Unit> {
        server.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        serveLocalWork(server)
        val glance = ServerGlances.load(profile, client())
        assertEquals(2, glance.needsYou, "1 task needing attention + 1 terminal waiting")
        assertEquals(2, glance.running, "1 running task + 1 working agent terminal")
        assertEquals(1, glance.hostsOnline)
        assertEquals(1, glance.hostsTotal)
        assertEquals("running", server.lastRequest("GET", "/api/local/terminals")?.queryParam("state"))
    }

    @Test
    fun aRejectedTokenIsToldApartFromADeadNetwork() = runBlocking<Unit> {
        server.error("GET", "/api/tasks/stats", 401, "Invalid or expired session")
        server.error("GET", "/api/auth/me", 401, "Invalid or expired session")
        assertEquals(ServerGlance.State.UNAUTHORIZED, ServerGlances.load(profile, client()).state)

        // Stats failing on its own with a good token: online, just no numbers.
        server.error("GET", "/api/tasks/stats", 500, "boom")
        server.json("/api/auth/me", """{"user":{"id":"u"},"authDisabled":true}""")
        with(ServerGlances.load(profile, client())) {
            assertEquals(ServerGlance.State.ONLINE, state)
            assertEquals(0, running)
        }

        assertEquals(ServerGlance.State.UNAUTHORIZED, ServerGlances.load(profile, null).state, "no token at all")
    }

    @Test
    fun anUnreachableServerSaysSo() = runBlocking<Unit> {
        val port = ServerSocket(0).use { it.localPort } // free, and closed again: connection refused
        val glance = ServerGlances.load(profile, ServerGlances.withGlanceTimeout(ApiClient("http://127.0.0.1:$port", "optio_pat_x")))
        assertEquals(ServerGlance.State.UNREACHABLE, glance.state)
    }

    @Test
    fun aSlowServerTimesOutInsteadOfHoldingTheCard() = runBlocking<Unit> {
        server.on("GET", "/api/*") { FakeResponse.json("{}").delayed(8_000) }
        val started = System.nanoTime()
        val glance = ServerGlances.load(profile, client())
        val seconds = (System.nanoTime() - started) / 1e9
        assertEquals(ServerGlance.State.UNREACHABLE, glance.state)
        assert(seconds < 14) { "gave up after ${"%.1f".format(seconds)} s" }
    }

    @Test
    fun theModelKeepsStaleNumbersWhileReloading() = runTest {
        val gates = mutableMapOf<String, CompletableDeferred<ServerGlance>>()
        val model = OtherServersModel { s -> gates.getOrPut(s.id) { CompletableDeferred() }.await() }
        val studio = OverviewSeed.studio
        val prod = OverviewSeed.prod

        launch { model.refresh(listOf(studio)) }
        runCurrent()
        assertEquals(listOf(ServerGlance.State.LOADING), model.glances.value.map { it.state })
        gates.getValue(studio.id).complete(ServerGlance(studio, ServerGlance.State.ONLINE, running = 4))
        runCurrent()
        assertEquals(4, model.glances.value.single().running)

        // Second pass: Studio keeps its numbers until its answer lands; Prod is new, so "Checking…".
        gates.clear()
        launch { model.refresh(listOf(studio, prod)) }
        runCurrent()
        assertEquals(listOf(ServerGlance.State.ONLINE, ServerGlance.State.LOADING), model.glances.value.map { it.state })
        assertEquals(4, model.glances.value.first().running)
        gates.getValue(prod.id).complete(ServerGlance(prod, ServerGlance.State.UNAUTHORIZED))
        runCurrent()
        assertEquals(ServerGlance.State.UNAUTHORIZED, model.glances.value[1].state)
        gates.getValue(studio.id).complete(ServerGlance(studio, ServerGlance.State.UNREACHABLE))
        runCurrent()
        assertEquals(listOf(ServerGlance.State.UNREACHABLE, ServerGlance.State.UNAUTHORIZED), model.glances.value.map { it.state })

        // A forgotten server drops out.
        gates.clear()
        launch { model.refresh(listOf(prod)) }
        runCurrent()
        assertEquals(listOf(prod.id), model.glances.value.map { it.server.id })
        gates.getValue(prod.id).complete(ServerGlance(prod, ServerGlance.State.ONLINE))
        runCurrent()
    }
}
