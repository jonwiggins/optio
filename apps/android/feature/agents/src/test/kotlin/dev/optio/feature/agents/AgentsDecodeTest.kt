package dev.optio.feature.agents

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.OptioJson
import dev.optio.core.model.PersistentAgentLogEvent
import dev.optio.core.model.PersistentAgentMessageEvent
import dev.optio.core.model.PersistentAgentMessageSenderType
import dev.optio.core.model.PersistentAgentPodLifecycle
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.model.PersistentAgentStateChangedEvent
import dev.optio.core.model.PersistentAgentTurnHaltReason
import dev.optio.core.model.PersistentAgentTurnHaltedEvent
import dev.optio.core.model.PersistentAgentTurnStartedEvent
import dev.optio.core.model.PersistentAgentWakeSource
import dev.optio.core.model.WsEvent
import dev.optio.core.model.boolValue
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.routes.AgentTurnRoute
import dev.optio.core.testing.Fixtures
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Test

/** Responses and socket frames captured from the private test API (DevLab seed) decode as the app reads them. */
class AgentsDecodeTest {
    @Serializable
    private data class Messages(val messages: List<dev.optio.core.model.PersistentAgentMessage>)

    @Serializable
    private data class Turns(val turns: List<dev.optio.core.model.PersistentAgentTurn>)

    @Serializable
    private data class Triggers(val triggers: List<PersistentAgentTrigger>)

    @Test
    fun agentDetailWithInbox() {
        val envelope = Fixtures.decode<PersistentAgentEnvelope>("agent-detail.json")
        val agent = envelope.agent
        assertEquals("release-captain", agent.slug)
        assertEquals("Release Captain", agent.name)
        assertEquals(PersistentAgentState.IDLE, agent.state)
        assertEquals(PersistentAgentPodLifecycle.STICKY, agent.podLifecycle)
        assertEquals("claude-code", agent.agentRuntime)
        assertNull(agent.model)
        assertEquals(300_000.0, agent.idlePodTimeoutMs)
        assertNotNull(agent.lastTurnAt)
        assertEquals(0, envelope.inbox?.pending)
    }

    @Test
    fun pendingInboxWithAPostgresTimestamp() {
        // Captured with a message waiting on a paused agent: `oldest` is Postgres text, not ISO.
        val envelope = Fixtures.decode<PersistentAgentEnvelope>("agent-detail-pending.json")
        val inbox = assertNotNull(envelope.inbox)
        assertEquals(1, inbox.pending)
        assertEquals("2026-09-23T01:22:37.388801Z", inbox.oldestInstant.toString())
        assertEquals(java.time.Instant.parse("2026-09-22T16:40:00Z"), LenientDates.parse(kotlinx.serialization.json.JsonPrimitive("2026-09-22T16:40:00Z")))
        assertEquals(java.time.Instant.parse("2026-09-22T16:40:00Z"), LenientDates.parse(kotlinx.serialization.json.JsonPrimitive("2026-09-22 18:40:00+02")))
        assertEquals(java.time.Instant.ofEpochMilli(1_758_559_200_000), LenientDates.parse(kotlinx.serialization.json.JsonPrimitive(1_758_559_200_000)))
        assertNull(LenientDates.parse(kotlinx.serialization.json.JsonPrimitive("yesterday")))
        assertNull(LenientDates.parse(null))
    }

    @Test
    fun pausedAgent() {
        val agent = Fixtures.decode<PersistentAgentEnvelope>("agent-detail-paused.json").agent
        assertEquals(PersistentAgentState.PAUSED, agent.state)
        assertEquals(PersistentAgentPodLifecycle.ON_DEMAND, agent.podLifecycle)
    }

    @Test
    fun messagesNewestFirstWithSenders() {
        val messages = Fixtures.decode<Messages>("agent-messages.json").messages
        assertTrue(messages.size >= 2)
        // Newest first from the API; the seed's init message (system) is the oldest.
        val oldest = messages.last()
        assertEquals(PersistentAgentMessageSenderType.SYSTEM, oldest.senderType)
        assertEquals("Optio", oldest.senderName)
        assertTrue(messages.any { it.senderType == PersistentAgentMessageSenderType.USER })
        assertTrue(messages.zipWithNext().all { (a, b) -> !a.receivedAt.isBefore(b.receivedAt) })
        assertTrue(messages.all { it.processedAt != null && it.turnId != null })
    }

    @Test
    fun turnsAndTurnDetailLogs() {
        val turns = Fixtures.decode<Turns>("agent-turns.json").turns
        assertEquals(listOf(3, 2, 1), turns.map { it.turnNumber.toInt() })
        val first = turns.last()
        assertEquals(PersistentAgentWakeSource.SYSTEM, first.wakeSource)
        assertEquals(PersistentAgentTurnHaltReason.NATURAL, first.haltReason)
        assertEquals("0.0123", first.costUsd)
        assertEquals(100.0, first.inputTokens)
        assertEquals("Natural", first.haltReason!!.label)

        val detail = Fixtures.decode<PersistentAgentTurnDetail>("agent-turn-detail.json")
        assertTrue(detail.turn.promptUsed!!.contains("---BEGIN OPTIO MESSAGE---"))
        val entries = detail.logs.map { it.asLogEntry("agent-1") }
        assertEquals(
            listOf(AgentLogEntry.TypeValue.SYSTEM, AgentLogEntry.TypeValue.TEXT, AgentLogEntry.TypeValue.INFO),
            entries.map { it.type },
        )
        assertTrue(entries.all { it.timestamp.isNotEmpty() && it.taskId == "agent-1" })
        assertEquals("fake-model", entries.first().metadata?.get("model")?.stringValue)
    }

    @Test
    fun triggersOfEveryType() {
        val seeded = Fixtures.decode<Triggers>("agent-triggers.json").triggers.single()
        assertEquals(AgentTriggerType.SCHEDULE, seeded.kind)
        assertEquals("0 8 * * *", seeded.summary)
        assertNotNull(seeded.nextFireAt)

        val all = Fixtures.decode<Triggers>("agent-triggers-all.json").triggers.associateBy { it.kind }
        assertEquals(AgentTriggerType.entries.toSet(), all.keys)
        assertEquals("0 9 * * 1-5 · weekdays at 09:00 UTC", all.getValue(AgentTriggerType.SCHEDULE).summary)
        assertEquals("/api/hooks/docs-gardener-hook", all.getValue(AgentTriggerType.WEBHOOK).summary)
        assertEquals("Linear · docs, cleanup", all.getValue(AgentTriggerType.TICKET).summary)
        assertEquals("review requested, mentioned · @octocat", all.getValue(AgentTriggerType.GITHUB).summary)
        assertEquals("#C0123ABCD · @-mentions only · “docs”", all.getValue(AgentTriggerType.SLACK).summary)
        assertEquals("created, labeled", all.getValue(AgentTriggerType.LINEAR).summary)
        assertEquals("By hand", all.getValue(AgentTriggerType.MANUAL).summary)
        assertTrue(all.values.all { it.enabled == true })
    }

    @Test
    fun liveEventFramesDecode() {
        val frames = Fixtures.text("agent-events.jsonl").lines().filter { it.isNotBlank() }.map { OptioJson.parseToJsonElement(it).jsonObject }
        // Catch-up logs of the latest turn come first, flagged.
        val catchUp = frames.takeWhile { it["catchUp"]?.boolValue == true }
        assertTrue(catchUp.isNotEmpty())
        catchUp.forEach { OptioJson.decodeFromJsonElement(PersistentAgentLogEvent.serializer(), it) }

        val events = frames.drop(catchUp.size).map { decodeEvent(it) }
        assertIs<PersistentAgentMessageEvent>(events.first())
        assertTrue(events.any { it is PersistentAgentTurnStartedEvent })
        val halted = events.filterIsInstance<PersistentAgentTurnHaltedEvent>().single()
        assertEquals(PersistentAgentTurnHaltReason.NATURAL, halted.haltReason)
        val states = events.filterIsInstance<PersistentAgentStateChangedEvent>().map { it.toState }
        assertEquals(listOf(PersistentAgentState.QUEUED, PersistentAgentState.PROVISIONING, PersistentAgentState.RUNNING, PersistentAgentState.IDLE), states)
        assertEquals(3, events.filterIsInstance<PersistentAgentLogEvent>().size)
    }

    @Test
    fun turnRouteRoundTrips() {
        val route = AgentTurnRoute(agentId = "a1", turnId = "t1", turnNumber = 3)
        val json = kotlinx.serialization.json.Json.encodeToString(AgentTurnRoute.serializer(), route)
        assertEquals(route, kotlinx.serialization.json.Json.decodeFromString(AgentTurnRoute.serializer(), json))
    }

    private fun decodeEvent(obj: JsonObject): WsEvent = OptioJson.decodeFromJsonElement(WsEvent.serializer(), obj)
}
