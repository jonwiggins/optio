package dev.optio.core.glance

import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.runBlocking

/**
 * [NeedsYouSnapshot.load] / [NeedsYouSnapshot.loadAll] against a fake server serving fixtures
 * captured from the private test API (`local-hosts`, `glance-watch`, `task-*`) and a constructed
 * running-terminals list (the seed has no live terminal) built from a captured row.
 */
class NeedsYouSnapshotLoadTest {
    private lateinit var server: FakeOptioServer
    private val now = Instant.parse("2026-09-22T16:40:00Z")

    @BeforeTest
    fun setUp() {
        server = FakeOptioServer().start()
        server.fixture("/api/local/hosts", "local-hosts-two-constructed.json")
        server.fixture("/api/local/terminals", "local-terminals-running-constructed.json")
        server.fixture("/api/glance/watch", "glance-watch.json")
    }

    @AfterTest
    fun tearDown() = server.close()

    private fun client(
        id: String = "srv-1",
        name: String = "Laptop",
    ) = ServerClient(ServerProfile(id = id, name = name, url = server.baseUrl), server.client())

    @Test
    fun loadsTerminalsWithChipsLinksAndTiles() =
        runBlocking {
            val snap = NeedsYouSnapshot.load(client(), now = now)
            assertEquals("running", server.lastRequest("GET", "/api/local/terminals")!!.queryParam("state"))
            assertEquals(1, snap.hostsOnline)
            assertEquals(2, snap.hostsTotal)
            assertEquals(SessionTileCounts(waiting = 2, recurring = 4, agents = 2), snap.counts, "tiles from the captured /api/glance/watch")
            assertEquals(listOf("t-need", "t-snoozed"), snap.needsYou.map { it.id })
            assertEquals(listOf("t-work", "t-shell-agent"), snap.running.map { it.id }, "an idle plain shell is not a session")

            val need = snap.needsYou[0]
            assertEquals(WatchItemKind.LOCAL, need.kind)
            assertEquals("web", need.mono)
            assertEquals("Waiting on a permission", need.reason)
            assertEquals("Allow Bash(pnpm test)? (y/n)", need.preview, "the last non-empty output line")
            assertEquals(Instant.parse("2026-09-22T16:36:00Z"), need.since)
            assertEquals("needs_you", need.state)
            assertEquals("optio://local/t-need?compose=1&server=srv-1", need.link)
            assertEquals("srv-1", need.serverId)
            assertEquals("Laptop", need.serverName)
            assertEquals("now", need.whenLabel)
            assertEquals(WatchWhereTarget.MACHINE, need.whereValue.target)
            assertEquals("MacBook Pro · ~/repos/optio/apps/web", need.whereValue.detail)
            assertEquals("claude-code", need.whoValue)
            assertEquals(WatchThen.WAITS_FOR_ME, need.thenValue)
            assertEquals("needs you", need.statusText)

            val snoozed = snap.needsYou[1]
            assertEquals(Instant.parse("2026-09-22T16:55:00Z"), snoozed.snoozedUntil)
            assertEquals("Claude stopped — reply to continue", snoozed.reason)

            val work = snap.running[0]
            assertEquals("blueprint", work.whenLabel)
            assertEquals("~/e2e-repo", work.whereValue.detail, "an unnamed host adds nothing to Where")
            assertEquals("codex", work.whoValue)
            assertEquals(WatchThen.EXITS, work.thenValue, "headless agents exit")
            assertEquals("working", work.statusText)
            assertEquals("terminal", snap.running[1].whoValue)

            val state = snap.watchState()
            assertEquals(WatchPhase.WAITING, state.phase)
            assertEquals("t-need", state.head?.id, "the snoozed older item drops behind")
            assertEquals(2, state.needsYouCount)
            assertEquals(4, state.recurringCount)
        }

    @Test
    fun followedTasksJoinTheQueueOrTheRunningListAndFinishedOnesAreSkipped() =
        runBlocking {
            server.fixture("/api/tasks/pr", "task-pr-opened.json")
            server.fixture("/api/tasks/na", "task-needs-attention.json")
            server.fixture("/api/tasks/done", "task-completed.json")
            server.error("GET", "/api/tasks/gone", 404, "Task not found")
            val snap = NeedsYouSnapshot.load(client(), followed = setOf("pr", "na", "done", "gone"), now = now)
            val attention = snap.needsYou.single { it.kind == WatchItemKind.TASK }
            assertEquals("Tidy up the config loader", attention.title)
            assertEquals("needs_attention", attention.state)
            assertEquals("main", attention.mono)
            assertEquals("needs attention", attention.statusText)
            assertTrue(attention.link.startsWith("optio://tasks/"))
            assertTrue(attention.link.endsWith("?server=srv-1"))
            val pr = snap.running.single { it.kind == WatchItemKind.TASK }
            assertEquals("PR #1 open · CI running", pr.reason)
            assertEquals("https://github.com/e2e-org/e2e-repo/pull/1", pr.prUrl)
            assertEquals(WatchWhereTarget.POD, pr.whereValue.target)
            assertEquals("e2e-org/e2e-repo", pr.whereValue.detail)
            assertEquals("PR open", pr.statusText)
            assertEquals(WatchThen.EXITS, pr.thenValue)
        }

    @Test
    fun tilesHideWhenTheWatchEndpointIsMissingOrUnauthorized() =
        runBlocking {
            server.error("GET", "/api/glance/watch", 401, "Authentication required")
            assertNull(NeedsYouSnapshot.load(client(), now = now).counts, "auth-disabled servers 401 the Watch frame")
            server.error("GET", "/api/glance/watch", 404, "Not found")
            assertNull(NeedsYouSnapshot.load(client(), now = now).counts)
        }

    @Test
    fun loadFailsWhenTheTerminalListFails() {
        server.error("GET", "/api/local/terminals", 401, "Invalid token")
        val error = assertFailsWith<ApiError> { runBlocking { NeedsYouSnapshot.load(client(), now = now) } }
        assertEquals(401, error.status)
    }

    @Test
    fun loadAllMergesAnsweringServersAndListsTheFailedOnes(): Unit =
        runBlocking {
            val dead = ServerClient(ServerProfile(id = "dead", name = "Dead", url = "http://127.0.0.1:9"), ApiClient("http://127.0.0.1:9", "x"))
            val slow = FakeOptioServer().start()
            slow.on("GET", "/api/local/hosts") { FakeResponse.json("""{"hosts":[]}""").delayed(2_000) }
            try {
                val slowClient = ServerClient(ServerProfile(id = "slow", name = "Slow", url = slow.baseUrl), slow.client())
                val result = NeedsYouSnapshot.loadAll(listOf(client(), dead, slowClient), timeout = 600.milliseconds, now = { now })
                assertEquals(setOf("dead", "slow"), result.failed.toSet())
                assertEquals(listOf("srv-1"), result.perServer.keys.toList())
                assertEquals(2, result.snapshot.needsYou.size)
                assertEquals(now, result.snapshot.asOf)
                assertNotNull(result.errors["dead"])
            } finally {
                slow.close()
            }
        }

    @Test
    fun loadAllThrowsWhenNoServerAnswers() {
        assertFailsWith<ApiError> { runBlocking { NeedsYouSnapshot.loadAll(emptyList<ServerClient>()) } }
        server.error("GET", "/api/local/hosts", 500, "boom")
        val error = assertFailsWith<ApiError> { runBlocking { NeedsYouSnapshot.loadAll(listOf(client())) } }
        assertEquals(500, error.status)
    }

    @Test
    fun capturedFixturesDecode() {
        // The real shapes from the private test API decode through the loose rows.
        val hosts = Fixtures.decode<HostsEnvelope>("local-hosts.json")
        assertEquals("E2E laptop", hosts.hosts.single().name)
        val task = Fixtures.decode<TaskEnvelope>("task-pr-opened.json").task
        assertEquals(1, task.prNumber)
        assertEquals("pr_opened", task.state)
        val tasks = Fixtures.decode<TasksEnvelope>("tasks-repo.json").tasks
        assertTrue(tasks.isNotEmpty())
        val watch = dev.optio.core.model.OptioJson.decodeFromString(dev.optio.core.model.WatchState.serializer(), Fixtures.text("glance-watch.json"))
        assertEquals(WatchPhase.DONE, GlanceWatchState.fromWire(watch).phase)
    }
}
