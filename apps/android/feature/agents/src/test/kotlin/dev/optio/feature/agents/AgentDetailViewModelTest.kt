package dev.optio.feature.agents

import dev.optio.core.glance.WatchSources
import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.model.PersistentAgentMessageSenderType
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.FakeSocket
import dev.optio.core.testing.Fixtures
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.jsonObject
import org.junit.After
import org.junit.Before
import org.junit.Rule
import org.junit.Test

/**
 * [AgentDetailViewModel] against a fake API: the first load, the events socket driving refreshes and
 * the live tail (incl. catch-up after a reconnect), and every action's request.
 */
class AgentDetailViewModelTest {
    @get:Rule
    val main = RealMainRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val id = "63cf2f4a-7616-4cec-8ee7-7585aa370f75"
    private val events = CopyOnWriteArrayList<AgentDetailViewModel.Event>()
    private val collector = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val sources = WatchSources.inMemory(collector)
    private lateinit var vm: AgentDetailViewModel

    @Before
    fun setUp() {
        server.fixture("/api/persistent-agents/:id", "agent-detail.json")
        server.fixture("/api/persistent-agents/:id/messages", "agent-messages.json")
        server.fixture("/api/persistent-agents/:id/turns", "agent-turns.json")
        server.fixture("/api/persistent-agents/:id/triggers", "agent-triggers.json")
        vm = main.onMain { AgentDetailViewModel(id, server.client(), fastSockets(), watchSources = sources) }
        collector.launch { vm.events.collect { events += it } }
    }

    @After
    fun tearDown() {
        main.onMain { vm.disconnect() }
        collector.cancel()
    }

    private fun loadAll() {
        main.onMain { vm.appeared() }
        eventually(message = { "first load" }) {
            vm.header.value.value != null && vm.messages.value.value != null && vm.turns.value.value != null && vm.triggers.value.value != null
        }
    }

    private fun connect(): FakeSocket {
        val endpoint = server.webSocket("/ws/persistent-agents/:id/events")
        main.onMain { vm.connect() }
        val socket = endpoint.awaitConnection(15_000)
        eventually(message = { "connected" }) { vm.connected.value }
        return socket
    }

    private fun log(turnId: String, content: String, catchUp: Boolean = false) =
        """{"type":"persistent_agent:log","agentId":"$id","agentSlug":"release-captain","turnId":"$turnId","content":"$content","stream":"stdout","logType":"text","timestamp":"2026-09-23T00:46:04.915Z"${if (catchUp) ""","catchUp":true""" else ""}}"""

    @Test
    fun firstLoadFillsEveryPart() {
        loadAll()
        assertEquals("Release Captain", vm.header.value.value!!.agent.name)
        assertEquals(0, vm.header.value.value!!.inbox.pending)
        // Messages read oldest → newest: the seeded init message first.
        val messages = vm.messages.value.value!!
        assertEquals(PersistentAgentMessageSenderType.SYSTEM, messages.first().senderType)
        assertTrue(messages.zipWithNext().all { (a, b) -> !a.receivedAt.isAfter(b.receivedAt) })
        assertEquals(3, vm.turns.value.value!!.size)
        assertEquals("schedule", vm.triggers.value.value!!.single().type)
        assertEquals("50", server.lastRequest("GET", "/api/persistent-agents/$id/messages")!!.queryParam("limit"))
        assertEquals("30", server.lastRequest("GET", "/api/persistent-agents/$id/turns")!!.queryParam("limit"))
    }

    @Test
    fun aFailedFirstLoadShowsTheError() {
        server.error("GET", "/api/persistent-agents/:id", 404, "Not found")
        main.onMain { vm.appeared() }
        eventually { vm.header.value.errorOrNull != null }
        assertEquals(404, (vm.header.value.errorOrNull as ApiError).status)
    }

    @Test
    fun liveTailFollowsTheCurrentTurn() {
        loadAll()
        val socket = connect()
        // Catch-up: the latest turn's logs.
        socket.sendText(log("turn-3", "catch 1", catchUp = true))
        socket.sendText(log("turn-3", "catch 2", catchUp = true))
        eventually { vm.live.value.entries.size == 2 }
        assertEquals("turn-3", vm.live.value.turnId)

        // A new turn starts: the tail empties, the agent and turns refresh.
        val turnsBefore = server.count("GET", "/api/persistent-agents/$id/turns")
        socket.sendText("""{"type":"persistent_agent:turn_started","agentId":"$id","agentSlug":"release-captain","turnId":"turn-4","turnNumber":4,"wakeSource":"user","timestamp":"2026-09-23T00:50:00Z"}""")
        eventually { vm.live.value.turnId == "turn-4" && vm.live.value.entries.isEmpty() }
        eventually { server.count("GET", "/api/persistent-agents/$id/turns") > turnsBefore }

        socket.sendText(log("turn-4", "working"))
        eventually { vm.live.value.entries.map { it.content } == listOf("working") }

        // A log from another turn re-anchors the tail.
        socket.sendText(log("turn-5", "next"))
        eventually { vm.live.value.turnId == "turn-5" && vm.live.value.entries.map { it.content } == listOf("next") }
    }

    @Test
    fun eventsRefreshWhatTheyTouch() {
        loadAll()
        val socket = connect()
        fun count(path: String) = server.count("GET", "/api/persistent-agents/$id$path")
        val messages = count("/messages")
        val agent = count("")
        socket.sendText(
            """{"type":"persistent_agent:message","agentId":"$id","agentSlug":"release-captain","messageId":"m9","senderType":"agent","body":"hi","broadcasted":false,"timestamp":"2026-09-23T00:50:00Z"}""",
        )
        eventually { count("/messages") > messages && count("") > agent }

        val turns = count("/turns")
        socket.sendText(
            """{"type":"persistent_agent:turn_halted","agentId":"$id","agentSlug":"release-captain","turnId":"t","turnNumber":4,"haltReason":"natural","timestamp":"2026-09-23T00:50:01Z"}""",
        )
        eventually { count("/turns") > turns }

        server.fixture("/api/persistent-agents/:id", "agent-detail-paused.json")
        socket.sendText(
            """{"type":"persistent_agent:state_changed","agentId":"$id","agentSlug":"release-captain","fromState":"idle","toState":"paused","trigger":"control","timestamp":"2026-09-23T00:50:02Z"}""",
        )
        eventually { vm.header.value.value?.agent?.state == PersistentAgentState.PAUSED }
    }

    @Test
    fun aBurstOfEventsCoalescesRefreshes() {
        loadAll()
        val calls = AtomicInteger()
        server.get("/api/persistent-agents/:id/turns") {
            calls.incrementAndGet()
            FakeResponse.fixture("agent-turns.json").delayed(150)
        }
        val socket = connect()
        repeat(10) {
            socket.sendText(
                """{"type":"persistent_agent:state_changed","agentId":"$id","agentSlug":"release-captain","toState":"running","trigger":"x","timestamp":"2026-09-23T00:50:02Z"}""",
            )
        }
        eventually { calls.get() >= 1 }
        Thread.sleep(600)
        assertTrue(calls.get() in 1..2, "10 events → ${calls.get()} turn fetches")
    }

    @Test
    fun reconnectReplacesTheCatchUpAndRefreshes() {
        loadAll()
        val endpoint = server.webSocket("/ws/persistent-agents/:id/events")
        main.onMain { vm.connect() }
        val first = endpoint.awaitConnection(15_000)
        first.sendText(log("turn-3", "a", catchUp = true))
        first.sendText(log("turn-3", "b", catchUp = true))
        eventually { vm.live.value.entries.size == 2 }

        val agentFetches = server.count("GET", "/api/persistent-agents/$id")
        first.close(1011, "restart")
        eventually { !vm.connected.value }
        val second = endpoint.awaitConnection(15_000)
        eventually { vm.connected.value }
        // The server replays the same turn's logs: they replace the tail instead of doubling it.
        second.sendText(log("turn-3", "a", catchUp = true))
        second.sendText(log("turn-3", "b", catchUp = true))
        second.sendText(log("turn-3", "c"))
        eventually { vm.live.value.entries.map { it.content } == listOf("a", "b", "c") }
        eventually { server.count("GET", "/api/persistent-agents/$id") > agentFetches }
    }

    @Test
    fun sendPostsTheMessageAndShowsItAtOnce() {
        loadAll()
        server.post("/api/persistent-agents/:id/messages") { FakeResponse.json("""{"ok":true}""", 202).delayed(200) }
        val sent = main.onMain {
            coroutineScope {
                val job = async { vm.send("  Status?  ") }
                // The pending bubble shows before the server answers.
                delay(50)
                assertEquals("Status?", vm.messages.value.value!!.last().body)
                assertNull(vm.messages.value.value!!.last().processedAt)
                job.await()
            }
        }
        assertTrue(sent)
        val request = server.lastRequest("POST", "/api/persistent-agents/$id/messages")!!
        assertEquals("Status?", request.json.jsonObject["body"]?.stringValue)
        // Then the stored list replaces it.
        eventually { vm.messages.value.value!!.none { it.id.startsWith("local-") } }
        // …and the turn it wakes may join the Watch (iOS `RecentAgentSends.record`).
        eventually(message = { "send recorded" }) { sources.isRecentAgentSend(id) }
    }

    @Test
    fun aFailedSendTakesTheBubbleBackAndSaysWhy() {
        loadAll()
        server.error("POST", "/api/persistent-agents/:id/messages", 403, "Forbidden")
        val before = vm.messages.value.value!!.size
        val sent = main.onMain { vm.send("hello") }
        assertEquals(false, sent)
        assertEquals(before, vm.messages.value.value!!.size)
        eventually { events.any { it is AgentDetailViewModel.Event.Failure } }
        assertTrue(runBlocking { sources.recentAgentSends() }.isEmpty(), "a message the server refused wakes nothing")
    }

    @Test
    fun controlSendsTheIntent() {
        loadAll()
        server.post("/api/persistent-agents/:id/control") { FakeResponse.json("""{"ok":true,"intent":"pause"}""") }
        main.onMain { vm.control(PersistentAgentControlIntent.PAUSE) }
        val request = server.awaitRequest("POST", "/api/persistent-agents/$id/control")
        assertEquals("pause", request.json.jsonObject["intent"]?.stringValue)
        eventually { events.any { it == AgentDetailViewModel.Event.Success("Pausing") } }
    }

    @Test
    fun deleteLeaves() {
        loadAll()
        server.delete("/api/persistent-agents/:id") { FakeResponse.empty() }
        main.onMain { vm.delete() }
        eventually { events.any { it == AgentDetailViewModel.Event.Deleted } }
    }

    @Test
    fun createAndDeleteTriggers() {
        loadAll()
        server.post("/api/persistent-agents/:id/triggers") { req ->
            val body = req.json.jsonObject
            FakeResponse.json(
                """{"trigger":{"id":"tr-new","type":${body["type"]},"config":${body["config"]},"enabled":true,"createdAt":"2026-09-23T01:00:00Z"}}""",
                201,
            )
        }
        val draft = AgentTriggerDraft(type = AgentTriggerType.SLACK, slackChannel = "C0123ABCD", slackMentionOnly = true)
        val failure = main.onMain { vm.createTrigger(draft) }
        assertEquals(null, failure)
        val body = server.lastRequest("POST", "/api/persistent-agents/$id/triggers")!!.json.jsonObject
        assertEquals("slack", body["type"]?.stringValue)
        assertEquals(draft.config(), body["config"])
        assertEquals("tr-new", vm.triggers.value.value!!.first().id)
        assertTrue(events.any { it == AgentDetailViewModel.Event.Success("Slack trigger added") })

        server.delete("/api/persistent-agents/:id/triggers/:triggerId") { FakeResponse.empty() }
        main.onMain { vm.deleteTrigger("tr-new") }
        assertTrue(vm.triggers.value.value!!.none { it.id == "tr-new" })
        server.awaitRequest("DELETE", "/api/persistent-agents/$id/triggers/tr-new")
    }

    @Test
    fun aRejectedTriggerStaysOpenWithTheServersReason() {
        loadAll()
        server.error("POST", "/api/persistent-agents/:id/triggers", 409, "Webhook path \"x\" is already in use")
        val refused = main.onMain { vm.createTrigger(AgentTriggerDraft(type = AgentTriggerType.WEBHOOK, webhookPath = "x")) }
        // The sheet shows this (QA: the toast alone drew under the sheet, so nothing was visible).
        assertEquals("Webhook path \"x\" is already in use", refused?.message)
        // The event collector runs on its own coroutine: wait for it rather than racing it.
        eventually { events.any { it is AgentDetailViewModel.Event.Failure } }
        val failure = events.filterIsInstance<AgentDetailViewModel.Event.Failure>().single()
        assertEquals("Webhook path \"x\" is already in use", failure.error.message)
    }

    @Test
    fun aFailedTriggerDeleteRestoresTheRow() {
        loadAll()
        val trigger = vm.triggers.value.value!!.single()
        server.error("DELETE", "/api/persistent-agents/:id/triggers/:triggerId", 500, "boom")
        main.onMain { vm.deleteTrigger(trigger.id) }
        eventually { events.any { it is AgentDetailViewModel.Event.Failure } }
        eventually { vm.triggers.value.value!!.any { it.id == trigger.id } }
    }

    @Test
    fun closedSocketTurnsTheLiveDotOff() {
        loadAll()
        val socket = connect()
        socket.close(4404, "Persistent agent not found")
        eventually { !vm.connected.value }
    }
}
