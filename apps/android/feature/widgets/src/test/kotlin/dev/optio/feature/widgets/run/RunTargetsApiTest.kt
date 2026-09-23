package dev.optio.feature.widgets.run

import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.feature.widgets.refresh.inFlightTasks
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Test

/**
 * The widget endpoints against responses captured from the private test API
 * (`src/test/resources/fixtures/`): listing run targets on every server, firing one, and the Repo
 * Tasks in flight.
 */
class RunTargetsApiTest {
    private val laptop = FakeOptioServer().start()
    private val studio = FakeOptioServer().start()

    @After
    fun close() {
        laptop.close()
        studio.close()
    }

    private fun client(
        server: FakeOptioServer,
        id: String,
        name: String,
    ) = ServerClient(ServerProfile(id = id, name = name, url = server.baseUrl), server.client())

    @Test
    fun oneServerListsBlueprintsThenJobsWithoutServerNames() =
        runTest {
            laptop.fixture("/api/local/blueprints", "local-blueprints.json")
            laptop.fixture("/api/jobs", "jobs.json")
            val targets = fetchAllRunTargets(listOf(client(laptop, "srv-a", "MacBook")))
            assertEquals(listOf("Fix flaky tests", "Triage Sentry alerts", "Nightly release notes"), targets.map { it.name })
            assertEquals(listOf(RunTarget.Kind.LOCAL, RunTarget.Kind.JOB, RunTarget.Kind.JOB), targets.map { it.kind })
            assertEquals("srv-a|local:51885e1d-5d5b-4485-973e-63bebbb73502", targets[0].id)
            assertEquals("auto", targets[0].spawnMode)
            assertTrue(targets.all { it.serverName == null }, "one server needs no names")
        }

    @Test
    fun severalServersNameTheirTargetsAndFailIndependently() =
        runTest {
            laptop.fixture("/api/local/blueprints", "local-blueprints.json")
            laptop.fixture("/api/jobs", "jobs.json")
            studio.error("GET", "/api/local/blueprints", 500, "boom")
            studio.json("/api/jobs", """{"workflows":[{"id":"j1","name":"Paused","enabled":false},{"id":"j2","name":"Digest"}]}""")
            val targets = fetchAllRunTargets(listOf(client(laptop, "srv-a", "MacBook"), client(studio, "srv-b", "Studio")))
            assertEquals(listOf("Fix flaky tests", "Triage Sentry alerts", "Nightly release notes", "Digest"), targets.map { it.name }, "disabled jobs are skipped")
            assertEquals(listOf("MacBook", "MacBook", "MacBook", "Studio"), targets.map { it.serverName })
            assertEquals("srv-b|job:j2", targets.last().id)
        }

    @Test
    fun firingAJobPostsAnEmptyBody() =
        runTest {
            laptop.post("/api/jobs/:id/runs") { FakeResponse.fixture("job-run-created.json", 201) }
            val receipt = laptop.client().fire(RunTarget("srv-a|job:34895caf", "Nightly", RunTarget.Kind.JOB))
            assertEquals(FireReceipt(), receipt)
            val request = laptop.lastRequest("POST", "/api/jobs/34895caf/runs")!!
            assertEquals("{}", request.body)
            assertEquals("Bearer optio_pat_test", request.header("Authorization"))
        }

    @Test
    fun firingABlueprintReadsTheSpawnedTerminal() =
        runTest {
            laptop.post("/api/local/blueprints/:id/spawn") { FakeResponse.fixture("blueprint-spawned.json", 201) }
            val receipt = laptop.client().fire(RunTarget("srv-a|local:e6af", "Fix flaky tests", RunTarget.Kind.LOCAL))
            // The seeded laptop is offline, so the spawn parks the terminal until it reconnects.
            assertEquals(FireReceipt(held = false, waitsForHost = true, dir = "e2e-repo"), receipt)

            laptop.post("/api/local/blueprints/:id/spawn") {
                FakeResponse.json("""{"terminal":{"id":"t","state":"pending","pendingReason":"hold","dir":"/x/web"}}""", 201)
            }
            assertEquals(FireReceipt(held = true, dir = "web"), laptop.client().fire(RunTarget("s|local:e6af", "Fix", RunTarget.Kind.LOCAL)))
        }

    @Test
    fun firingFailuresSurface() =
        runTest {
            laptop.error("POST", "/api/jobs/:id/runs", 404, "Workflow not found")
            val error = assertFailsWith<ApiError> { laptop.client().fire(RunTarget("s|job:gone", "Gone", RunTarget.Kind.JOB)) }
            assertEquals(404, error.status)
            assertFailsWith<ApiError> { laptop.client().fire(RunTarget("bogus", "?", RunTarget.Kind.JOB)) }

            laptop.post("/api/jobs/:id/runs") { FakeResponse.json("{}", 201).delayed(2_000) }
            assertFailsWith<TimeoutCancellationException> { laptop.client().fire(RunTarget("s|job:slow", "Slow", RunTarget.Kind.JOB), timeout = 100.milliseconds) }
        }

    @Test
    fun inFlightTasksKeepFourActiveOnesTaggedWithTheirServer() =
        runTest {
            laptop.fixture("/api/tasks", "tasks-repo.json")
            val server = ServerProfile(id = "srv-a", name = "MacBook", url = laptop.baseUrl)
            val tasks = laptop.client().inFlightTasks(server)
            assertEquals(listOf("queued", "pr_opened", "running", "needs_attention"), tasks.map { it.state })
            assertTrue(tasks.all { it.serverId == "srv-a" && it.serverName == "MacBook" })
            val pr = tasks[1]
            assertEquals(4, pr.prNumber)
            assertEquals(Instant.parse("2026-09-23T01:13:36.867Z"), pr.startedAt)
            assertEquals("main", pr.branch)
            val request = laptop.lastRequest("GET", "/api/tasks")!!
            assertEquals("8", request.queryParam("limit"))
            assertEquals("repo-task", request.queryParam("type"))
            assertFalse(tasks.any { it.state == "completed" || it.state == "cancelled" || it.state == "failed" })
        }
}
