package dev.optio.feature.local.api

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalSpawnSource
import dev.optio.core.model.LocalTerminalPendingReason
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.Triggers
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Rule
import org.junit.Test

/**
 * The Local endpoints against [dev.optio.core.testing.FakeOptioServer]: responses captured from the
 * private test API (DevLab seed + the isolated daemon, paths sanitised) decode, and every request
 * goes out with the method, path and body the routes in `apps/api/src/routes/local.ts` take.
 */
class LocalApiTest {
    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server
    private val api by lazy { server.client() }

    private val recordedId = "f4a0b2c8-5b2e-4a7d-9d2e-2a6f0b1c3d4e"

    @Test
    fun hostsDecode() =
        runBlocking {
            server.fixture("/api/local/hosts", "local-hosts-live.json")
            val hosts = api.listLocalHosts()
            assertEquals(2, hosts.size)
            val online = hosts.single { it.state == LocalHostState.ONLINE }
            assertEquals("devlab-mac", online.name)
            assertEquals(listOf("/Users/dev/playground/e2e-repo", "/Users/dev/playground/scratch"), online.dirs.map { it.path })
            assertEquals("https://github.com/e2e-org/e2e-repo", online.dirs.first().repoUrl)
            val offline = hosts.single { it.state == LocalHostState.OFFLINE }
            assertEquals("E2E laptop", offline.name)
            assertTrue(offline.lastSeenAt != null)
        }

    @Test
    fun terminalsDecodeEveryKindTheSeedMakes() =
        runBlocking {
            server.fixture("/api/local/terminals", "local-terminals.json")
            val terminals = api.listLocalTerminals()
            assertEquals(4, terminals.size)
            val parkedTask = terminals.first { it.spawnedBy == LocalSpawnSource.TASK }
            assertEquals(LocalTerminalState.PENDING, parkedTask.state)
            assertEquals(LocalTerminalPendingReason.HOST_OFFLINE, parkedTask.pendingReason)
            assertTrue(parkedTask.spec is LocalTerminalSpec.Agent)
            assertTrue(parkedTask.taskId != null)
            val shell = terminals.first { it.title == "Notes shell" }
            assertEquals(LocalTerminalSpec.Shell, shell.spec)
            val build = terminals.first { it.title == "npm run build" }
            assertEquals(2.0, build.exitCode)
            assertEquals("npm run build", (build.spec as LocalTerminalSpec.Command).command)
            val recorded = terminals.first { it.spawnedBy == LocalSpawnSource.BLUEPRINT }
            assertEquals(LocalAttentionState.NEEDS_YOU, recorded.attentionState)
            assertEquals("done", recorded.attentionReason)
            assertEquals("done — review the result", LocalPresentation.attentionLabel(recorded.attentionReason))
            assertTrue(LocalPresentation.canResume(recorded), "Claude Code reported its session id")
            assertEquals("e2e-org/e2e-repo#412", recorded.links.single().label)
        }

    @Test
    fun oneTerminalDecodes() =
        runBlocking {
            server.fixture("/api/local/terminals/:id", "local-terminal-recorded.json")
            val t = api.getLocalTerminal(recordedId)
            assertEquals(LocalTerminalState.EXITED, t.state)
            assertEquals(0.0, t.exitCode)
            assertEquals(LocalAgentKind.CLAUDE_CODE, (t.spec as LocalTerminalSpec.Agent).agent)
            assertEquals("/api/local/terminals/$recordedId", server.lastRequest("GET")!!.path)
        }

    @Test
    fun automationsAndTriggersDecode() =
        runBlocking {
            server.fixture("/api/local/blueprints", "local-blueprints.json")
            server.fixture("/api/local/blueprints/:id/triggers", "local-blueprint-triggers.json")
            val bp = api.listLocalBlueprints().single()
            assertEquals("Fix flaky tests", bp.name)
            assertEquals(LocalBlueprintSpawnMode.AUTO, bp.spawnMode)
            val trigger = api.listLocalBlueprintTriggers(bp.id).single()
            assertEquals("schedule", trigger.type)
            assertEquals("0 7 * * 1-5", Triggers.summary(trigger))
            assertTrue(trigger.nextFireAt != null)
            assertNull(trigger.lastFiredAt)
        }

    @Test
    fun terminalActionsSendWhatTheRoutesTake() =
        runBlocking {
            val terminal = Fixtures.text("local-terminal-recorded.json")
            server.post("/api/local/terminals/:id/start") { FakeResponse.json(terminal) }
            server.post("/api/local/terminals/:id/kill") { FakeResponse.json("{}") }
            server.post("/api/local/terminals/:id/resume") { FakeResponse.json(terminal, 201) }
            server.post("/api/local/terminals/:id/snooze") { FakeResponse.json(terminal) }
            server.delete("/api/local/terminals/:id/snooze") { FakeResponse.json(terminal) }
            server.post("/api/local/terminals/:id/input") { FakeResponse.json("{}") }
            server.patch("/api/local/terminals/:id") { FakeResponse.json(terminal) }
            server.delete("/api/local/terminals/:id") { FakeResponse.json("{}") }

            api.startLocalTerminal("t1")
            assertEquals("", server.lastRequest("POST", "/api/local/terminals/t1/start")!!.body)
            api.killLocalTerminal("t1")
            assertEquals("{}", server.lastRequest("POST", "/api/local/terminals/t1/kill")!!.body)
            api.killLocalTerminal("t1", "SIGKILL")
            assertEquals("""{"signal":"SIGKILL"}""", server.lastRequest("POST", "/api/local/terminals/t1/kill")!!.body)
            api.resumeLocalTerminal("t1")
            assertEquals("{}", server.lastRequest("POST", "/api/local/terminals/t1/resume")!!.body)
            api.snoozeLocalTerminal("t1", 15)
            assertEquals("""{"minutes":15}""", server.lastRequest("POST", "/api/local/terminals/t1/snooze")!!.body)
            api.unsnoozeLocalTerminal("t1")
            assertEquals("DELETE", server.lastRequest(path = "/api/local/terminals/t1/snooze")!!.method)
            api.sendLocalTerminalInput("t1", "ls\r")
            assertEquals("""{"data":"ls\r"}""", server.lastRequest("POST", "/api/local/terminals/t1/input")!!.body)
            api.renameLocalTerminal("t1", "Renamed")
            assertEquals("""{"title":"Renamed"}""", server.lastRequest("PATCH", "/api/local/terminals/t1")!!.body)
            api.deleteLocalTerminal("t1")
            val delete = server.lastRequest("DELETE", "/api/local/terminals/t1")!!
            assertEquals("", delete.body)
            // Fastify 400s a bodiless request that claims a JSON body.
            assertNull(delete.header("Content-Type"))
        }

    @Test
    fun transcriptPagesAskForWhatsAfterTheLastSeq() =
        runBlocking {
            server.fixture("/api/local/terminals/:id/transcript", "local-transcript.json")
            val page = api.getLocalTerminalTranscript("t1")
            assertEquals(14, page.entries.size)
            val first = server.lastRequest("GET")!!
            assertNull(first.queryParam("after"), "after=0 is left out")
            assertEquals("2000", first.queryParam("limit"))
            api.getLocalTerminalTranscript("t1", after = 14, limit = 50)
            assertEquals("14", server.lastRequest("GET")!!.queryParam("after"))
            assertEquals("50", server.lastRequest("GET")!!.queryParam("limit"))
        }

    @Test
    fun automationWritesSendWhatTheRoutesTake() =
        runBlocking {
            val bp = Fixtures.text("local-blueprints.json").let { it.substring(it.indexOf('[') + 1, it.lastIndexOf(']')) }
            val trigger = Fixtures.text("local-blueprint-triggers.json").let { it.substring(it.indexOf('[') + 1, it.lastIndexOf(']')) }
            server.post("/api/local/blueprints") { FakeResponse.json("""{"blueprint":$bp}""", 201) }
            server.patch("/api/local/blueprints/:id") { FakeResponse.json("""{"blueprint":$bp}""") }
            server.post("/api/local/blueprints/:id/spawn") { FakeResponse.json(Fixtures.text("local-terminal-recorded.json"), 201) }
            server.post("/api/local/blueprints/:id/triggers") { FakeResponse.json("""{"trigger":$trigger}""", 201) }
            server.patch("/api/local/blueprints/:id/triggers/:tid") { FakeResponse.json("""{"trigger":$trigger}""") }
            server.delete("/api/local/blueprints/:id/triggers/:tid") { FakeResponse.json("{}") }
            server.delete("/api/local/blueprints/:id") { FakeResponse.json("{}") }

            api.createLocalBlueprint(LocalBlueprintBody(name = "N", commandTemplate = "ls", agent = LocalAgentKind.CODEX))
            assertEquals("""{"name":"N","commandTemplate":"ls","agent":"codex"}""", server.lastRequest("POST", "/api/local/blueprints")!!.body)
            api.updateLocalBlueprint("b1", LocalBlueprintBody(enabled = false))
            assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/local/blueprints/b1")!!.body)
            api.updateLocalBlueprint("b1", LocalBlueprintBody(clearAgent = true, clearHost = true))
            assertEquals("""{"hostId":null,"agent":null}""", server.lastRequest("PATCH", "/api/local/blueprints/b1")!!.body)
            api.spawnLocalBlueprint("b1")
            assertEquals("{}", server.lastRequest("POST", "/api/local/blueprints/b1/spawn")!!.body)
            api.createLocalBlueprintTrigger("b1", "schedule", JsonObject(mapOf("cronExpression" to JsonPrimitive("0 9 * * *"))))
            assertEquals("""{"type":"schedule","config":{"cronExpression":"0 9 * * *"}}""", server.lastRequest("POST", "/api/local/blueprints/b1/triggers")!!.body)
            api.setLocalBlueprintTriggerEnabled("b1", "t9", false)
            assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/local/blueprints/b1/triggers/t9")!!.body)
            api.deleteLocalBlueprintTrigger("b1", "t9")
            assertEquals("DELETE", server.lastRequest(path = "/api/local/blueprints/b1/triggers/t9")!!.method)
            api.deleteLocalBlueprint("b1")
            assertEquals("DELETE", server.lastRequest(path = "/api/local/blueprints/b1")!!.method)
        }

    @Test
    fun serverReasonsSurface() =
        runBlocking {
            server.error("POST", "/api/local/terminals/:id/resume", 409, "Session never reported an id")
            val e = assertFailsWith<ApiError> { api.resumeLocalTerminal("t1") }
            assertEquals(409, e.status)
            assertEquals("Session never reported an id", dev.optio.feature.local.ui.actionFailure(e, "resume the session"))
            server.error("POST", "/api/local/terminals/:id/kill", 500, "boom")
            val e5 = assertFailsWith<ApiError> { api.killLocalTerminal("t1") }
            assertEquals("Couldn't kill the terminal — the server hit an error.", dev.optio.feature.local.ui.actionFailure(e5, "kill the terminal"))
            server.error("DELETE", "/api/local/terminals/:id", 404, "Terminal not found")
            val e4 = assertFailsWith<ApiError> { api.deleteLocalTerminal("t1") }
            assertEquals("Couldn't delete the terminal — it no longer exists.", dev.optio.feature.local.ui.actionFailure(e4, "delete the terminal"))
        }
}
