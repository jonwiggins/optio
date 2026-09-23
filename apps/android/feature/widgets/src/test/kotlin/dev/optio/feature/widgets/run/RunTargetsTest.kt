package dev.optio.feature.widgets.run

import dev.optio.core.data.ServerClient
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.RunTarget
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.TimeoutCancellationException
import kotlinx.coroutines.test.runTest
import org.junit.After
import org.junit.Test

/**
 * The widget side of run targets (iOS `RunTargetEntity` / `RunTargetQuery` / `RunTargetIntent`):
 * id namespacing as the widgets use it, resolving configured ids, listing every server's targets
 * and firing one, against responses captured from the private test API.
 */
class RunTargetsTest {
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

    private fun target(id: String) = RunTarget(id, "x", RunTarget.parse(id)?.kind ?: RunTarget.Kind.JOB)

    @Test
    fun namespacedIdsAsTheWidgetsUseThem() {
        val job = target(RunTarget.makeId("dev-server_2", RunTarget.Kind.JOB, "9b2c"))
        assertEquals("dev-server_2|job:9b2c", job.id)
        assertEquals("dev-server_2", job.serverId)
        assertEquals("9b2c", job.rawId)
        assertEquals("job", job.kindWord)
        assertEquals("/api/jobs/9b2c/runs", job.firePath)
        val blueprint = target("srv|local:abc")
        assertEquals("blueprint", blueprint.kindWord)
        assertEquals("/api/local/blueprints/abc/spawn", blueprint.firePath)
        assertEquals(null, target("local:abc").serverId, "legacy ids fire on the active server")
        assertEquals(null, target("bogus").firePath)
    }

    @Test
    fun resolveMatchesExactIdsFirst() {
        val all = listOf(RunTarget("a|job:1", "Nightly", RunTarget.Kind.JOB), RunTarget("b|job:1", "Nightly (b)", RunTarget.Kind.JOB))
        assertEquals(listOf(all[1]), resolveRunTargets(listOf("b|job:1"), all))
    }

    @Test
    fun resolveMapsLegacyIdsToTheActiveServersTarget() {
        val all = listOf(RunTarget("active|local:x", "Deploy", RunTarget.Kind.LOCAL, "auto"), RunTarget("other|local:x", "Deploy (other)", RunTarget.Kind.LOCAL))
        assertEquals(listOf(RunTarget("local:x", "Deploy", RunTarget.Kind.LOCAL, "auto")), resolveRunTargets(listOf("local:x"), all), "keeps the configured id")
    }

    @Test
    fun resolveKeepsMissingTargetsAsPlaceholders() {
        val resolved = resolveRunTargets(listOf("gone|job:1", "gone|local:2"), emptyList()) { id -> if (id == "gone") "Studio" else null }
        assertEquals(
            listOf(
                RunTarget("gone|job:1", "Job", RunTarget.Kind.JOB, serverName = "Studio"),
                RunTarget("gone|local:2", "Blueprint", RunTarget.Kind.LOCAL, serverName = "Studio"),
            ),
            resolved,
        )
        assertEquals(emptyList(), resolveRunTargets(listOf("bogus"), emptyList()), "malformed ids resolve to nothing")
    }

    @Test
    fun everyServersTargetsFromCapturedResponses() =
        runTest {
            laptop.fixture("/api/local/blueprints", "local-blueprints.json")
            laptop.fixture("/api/jobs", "jobs.json")
            studio.error("GET", "/api/local/blueprints", 500, "boom")
            studio.json("/api/jobs", """{"workflows":[{"id":"j1","name":"Paused","enabled":false},{"id":"j2","name":"Digest"}]}""")
            val one = RunTarget.fetchAll(listOf(client(laptop, "srv-a", "MacBook")))
            assertEquals(listOf("Fix flaky tests", "Triage Sentry alerts", "Nightly release notes"), one.map { it.name })
            assertEquals("srv-a|local:51885e1d-5d5b-4485-973e-63bebbb73502", one[0].id)
            assertTrue(one.all { it.serverName == null }, "one server needs no names")

            val two = RunTarget.fetchAll(listOf(client(laptop, "srv-a", "MacBook"), client(studio, "srv-b", "Studio")))
            assertEquals(listOf("Fix flaky tests", "Triage Sentry alerts", "Nightly release notes", "Digest"), two.map { it.name }, "failures and disabled jobs drop out")
            assertEquals(listOf("MacBook", "MacBook", "MacBook", "Studio"), two.map { it.serverName })
        }

    @Test
    fun firingAJobPostsAnEmptyBody() =
        runTest {
            laptop.post("/api/jobs/:id/runs") { FakeResponse.fixture("job-run-created.json", 201) }
            assertEquals(FireReceipt(), laptop.client().fire(target("srv-a|job:34895caf")))
            val request = laptop.lastRequest("POST", "/api/jobs/34895caf/runs")!!
            assertEquals("{}", request.body)
            assertEquals("Bearer optio_pat_test", request.header("Authorization"))
        }

    @Test
    fun firingABlueprintReadsTheSpawnedTerminal() =
        runTest {
            laptop.post("/api/local/blueprints/:id/spawn") { FakeResponse.fixture("blueprint-spawned.json", 201) }
            // The seeded laptop is offline, so the spawn parks the terminal until it reconnects.
            assertEquals(FireReceipt(waitsForHost = true, dir = "e2e-repo"), laptop.client().fire(target("srv-a|local:e6af")))
            laptop.post("/api/local/blueprints/:id/spawn") {
                FakeResponse.json("""{"terminal":{"id":"t","state":"pending","pendingReason":"hold","dir":"/x/web"}}""", 201)
            }
            assertEquals(FireReceipt(held = true, dir = "web"), laptop.client().fire(target("s|local:e6af")))
            laptop.post("/api/local/blueprints/:id/spawn") {
                FakeResponse.json("""{"terminal":{"id":"t","state":"running","dir":"/Users/me/repos/web/"}}""", 201)
            }
            assertEquals(FireReceipt(dir = "web"), laptop.client().fire(target("s|local:e6af")))
        }

    @Test
    fun firingFailuresSurface() =
        runTest {
            laptop.error("POST", "/api/jobs/:id/runs", 404, "Workflow not found")
            assertEquals(404, assertFailsWith<ApiError> { laptop.client().fire(target("s|job:gone")) }.status)
            assertFailsWith<ApiError> { laptop.client().fire(target("bogus")) }
            laptop.post("/api/jobs/:id/runs") { FakeResponse.json("{}", 201).delayed(2_000) }
            assertFailsWith<TimeoutCancellationException> { laptop.client().fire(target("s|job:slow"), timeout = 100.milliseconds) }
        }
}
