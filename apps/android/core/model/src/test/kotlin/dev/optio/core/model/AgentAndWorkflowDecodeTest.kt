package dev.optio.core.model

import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test

class AgentAndWorkflowDecodeTest {
    /** `GET /api/persistent-agents/:id`. */
    @Serializable
    private data class AgentResponse(val agent: PersistentAgent, val inbox: List<PersistentAgentMessage>)

    @Serializable
    private data class WorkflowResponse(val workflow: Workflow)

    @Serializable
    private data class RunsResponse(val runs: List<WorkflowRun>)

    @Test
    fun decodesAPersistentAgentAndItsInbox() {
        val response = Fixtures.decode<AgentResponse>("persistent-agent.json")
        val agent = response.agent
        assertEquals("forge", agent.slug)
        assertEquals(PersistentAgentPodLifecycle.STICKY, agent.podLifecycle)
        assertEquals(PersistentAgentState.IDLE, agent.state)
        assertEquals("1.2345", agent.totalCostUsd)
        assertEquals(600000.0, agent.idlePodTimeoutMs)
        assertEquals("# Forge\nYou babysit CI.", agent.agentsMd)
        assertNull(agent.controlIntent)
        assertNull(agent.reconcileBackoffUntil)
        assertEquals(Instant.parse("2026-09-22T15:58:03.221Z"), agent.lastTurnAt)
        assertEquals(Instant.parse("2026-09-01T08:00:00Z"), agent.createdAt)

        val (fromUser, fromTheFuture) = response.inbox
        assertEquals(PersistentAgentMessageSenderType.USER, fromUser.senderType)
        assertEquals(Instant.parse("2026-09-22T15:57:02Z"), fromUser.processedAt)
        assertEquals(PersistentAgentMessageSenderType.UNKNOWN, fromTheFuture.senderType)
        // Epoch milliseconds decode too.
        assertEquals(Instant.ofEpochMilli(1790092620000), fromTheFuture.receivedAt)
        assertNull(fromTheFuture.structuredPayload)
        assertNull(fromTheFuture.processedAt)
    }

    @Test
    fun decodesAWorkflow() {
        val workflow = Fixtures.decode<WorkflowResponse>("workflow.json").workflow
        assertEquals("Triage new issues", workflow.name)
        assertEquals("Triage {{issue}}", workflow.runTitle)
        assertEquals(RunTarget.LOCAL, workflow.runTarget)
        assertEquals(LocalAgentSessionMode.HEADLESS, workflow.localSessionMode)
        assertEquals("2.00", workflow.budgetUsd)
        assertEquals(20.0, workflow.maxTurns)
        assertNull(workflow.environmentSpec)
        assertNull(workflow.description)
        assertEquals(JsonPrimitive("object"), assertNotNull(workflow.paramsSchema)["type"])
        assertEquals(Instant.parse("2026-09-20T09:00:00Z"), workflow.updatedAt)
    }

    @Test
    fun decodesWorkflowRuns() {
        val (done, cancelled) = Fixtures.decode<RunsResponse>("workflow-runs.json").runs
        assertEquals(WorkflowRunState.COMPLETED, done.state)
        assertEquals("Triage acme/web#311", done.title)
        assertEquals("2", assertNotNull(done.params)["priority"]?.jsonPrimitive?.content)
        assertEquals("0b7e6f4a-2c1d-4e9b-8a3f-5d6c7b8a9e01", done.localTerminalId)
        assertEquals(Instant.parse("2026-09-22T10:02:31.250Z"), done.finishedAt)

        // The API documents `cancelled` (the shared enum carries it).
        assertEquals(WorkflowRunState.CANCELLED, cancelled.state)
        assertEquals(1.0, cancelled.retryCount)
        assertNull(cancelled.title)
        assertNull(cancelled.startedAt)
        assertNull(cancelled.params)
        // Epoch seconds, epoch milliseconds and a UTC offset.
        assertEquals(Instant.ofEpochSecond(1790071200), cancelled.finishedAt)
        assertEquals(Instant.ofEpochMilli(1790071000000), cancelled.createdAt)
        assertEquals(Instant.parse("2026-09-22T08:00:00Z"), cancelled.updatedAt)
    }
}
