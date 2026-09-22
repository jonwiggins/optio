package dev.optio.core.model

import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Test

class WsEventDecodeTest {
    private val events = Fixtures.decode<List<WsEvent>>("ws-events.json")

    @Test
    fun decodesKnownVariantsIntoTheirStructs() {
        val stateChanged = assertIs<TaskStateChangedEvent>(events[0])
        assertEquals(TaskState.RUNNING, stateChanged.fromState)
        assertEquals(TaskState.PR_OPENED, stateChanged.toState)
        assertEquals("0.4210", stateChanged.costUsd)
        assertEquals(182344.0, stateChanged.inputTokens)
        assertNull(stateChanged.errorMessage)

        val log = assertIs<TaskLogEvent>(events[1])
        assertEquals(TaskLogEvent.Stream.STDOUT, log.stream)
        assertEquals("Running pnpm test…", log.content)

        val pending = assertIs<TaskPendingReasonEvent>(events[2])
        assertNull(pending.data.pendingReason)

        // One struct, two discriminator values.
        val acked = assertIs<TaskMessageDeliveredEvent>(events[3])
        assertEquals(TaskMessageDeliveredEvent.TypeValue.TASK_MESSAGE_ACKED, acked.type)

        val runLog = assertIs<WorkflowRunLogEvent>(events[4])
        assertEquals(WorkflowRunLogEvent.Stream.STDERR, runLog.stream)
        assertEquals(JsonPrimitive("Bash"), runLog.metadata?.get("toolName"))

        val review = assertIs<PrReviewStateChangedEvent>(events[5])
        assertNull(review.fromState)
        assertEquals(PrReviewState.REVIEWING, review.toState)

        // A known event carrying a state this client does not know yet.
        val agentState = assertIs<PersistentAgentStateChangedEvent>(events[6])
        assertEquals(PersistentAgentState.IDLE, agentState.fromState)
        assertEquals(PersistentAgentState.UNKNOWN, agentState.toState)

        val halted = assertIs<PersistentAgentTurnHaltedEvent>(events[7])
        assertEquals(PersistentAgentTurnHaltReason.WAIT_TOOL, halted.haltReason)
        assertEquals(12.0, halted.turnNumber)

        val message = assertIs<PersistentAgentMessageEvent>(events[8])
        assertEquals(PersistentAgentMessageEvent.SenderType.AGENT, message.senderType)
        assertEquals(true, message.broadcasted)

        val activity = assertIs<ActivityNewEvent>(events[9])
        assertEquals("task", activity.resourceType)
        assertNull(activity.userId)
    }

    @Test
    fun unknownEventsFallBackToUnknownWithTheirRawJson() {
        // `local:changed` is published on /ws/events but is not part of the `WsEvent` union.
        val localChanged = assertIs<WsEvent.Unknown>(events[10])
        assertEquals(JsonPrimitive("local:changed"), localChanged.raw.jsonObject["type"])
        // …so the raw JSON can still be read as the struct that describes it.
        val decoded = OptioJson.decodeFromJsonElement(LocalChangedEvent.serializer(), localChanged.raw)
        assertEquals("9d2e4c6a-8b0f-4a1e-b3c5-d7e9f1a3b5c7", decoded.hostId)

        val future = assertIs<WsEvent.Unknown>(events[11])
        assertEquals(JsonPrimitive("future:event"), future.raw.jsonObject["type"])

        val noDiscriminator = assertIs<WsEvent.Unknown>(events[12])
        assertEquals(JsonPrimitive("no discriminator at all"), noDiscriminator.raw.jsonObject["event"])
    }

    @Test
    fun framesThatAreNotObjectsAreUnknownToo() {
        assertEquals(
            WsEvent.Unknown(JsonPrimitive("hello")),
            OptioJson.decodeFromString(WsEvent.serializer(), "\"hello\""),
        )
        assertEquals(WsEvent.Unknown(JsonNull), OptioJson.decodeFromString(WsEvent.serializer(), "null"))
        assertEquals(
            WsEvent.Unknown(OptioJson.parseToJsonElement("""{"type":42}""")),
            OptioJson.decodeFromString(WsEvent.serializer(), """{"type":42}"""),
        )
    }

    @Test
    fun whenOverTheUnionIsExhaustive() {
        fun label(event: WsEvent): String = when (event) {
            is TaskStateChangedEvent -> "state"
            is TaskLogEvent -> "log"
            is WsEvent.Unknown -> "unknown"
            else -> "other"
        }
        assertEquals(listOf("state", "log"), events.take(2).map(::label))
        assertEquals("unknown", label(events.last()))
    }

    @Test
    fun encodesVariantsAndPassesUnknownThrough() {
        val log: WsEvent = TaskLogEvent(
            type = "task:log",
            taskId = "t1",
            stream = TaskLogEvent.Stream.STDERR,
            content = "boom",
            timestamp = "2026-09-22T16:30:01.000Z",
        )
        val json = OptioJson.encodeToString(WsEvent.serializer(), log)
        assertEquals(
            """{"type":"task:log","taskId":"t1","stream":"stderr","content":"boom","timestamp":"2026-09-22T16:30:01.000Z"}""",
            json,
        )
        assertEquals(log, OptioJson.decodeFromString(WsEvent.serializer(), json))

        val raw = """{"type":"future:event","payload":{"anything":[1,2,3]}}"""
        val unknown = OptioJson.decodeFromString(WsEvent.serializer(), raw)
        assertEquals(raw, OptioJson.encodeToString(WsEvent.serializer(), unknown))
    }
}
