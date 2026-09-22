package dev.optio.core.model

import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Test

class TaskDecodeTest {
    /** `GET /api/tasks/:id` — a route-local envelope, as feature modules declare them. */
    @Serializable
    private data class TaskResponse(val task: OptioTask, val stallInfo: StallInfo? = null)

    @Test
    fun decodesATaskRowAsTheApiSendsIt() {
        val response = Fixtures.decode<TaskResponse>("task.json")
        val task = response.task

        assertEquals("5f1c2a9e-8d7b-4c3e-9a1f-2b6d8e4c7a10", task.id)
        assertEquals("Fix flaky login test", task.title)
        assertEquals(TaskState.PR_OPENED, task.state)
        assertEquals("claude-code", task.agentType)
        assertEquals("https://github.com/acme/web/pull/42", task.prUrl)
        assertEquals(0.0, task.retryCount)
        assertEquals(3.0, task.maxRetries)
        assertEquals(RunTarget.CLUSTER, task.runTarget)
        assertEquals(TaskActivitySubstate.ACTIVE, task.activitySubstate)
        // Optional in TS, explicit null on the wire.
        assertNull(task.localHostId)
        assertNull(task.localSessionMode)
        assertNull(task.errorMessage)

        // Dates: ISO with and without fractional seconds, and null.
        assertEquals(Instant.parse("2026-09-22T16:02:11.004Z"), task.createdAt)
        assertEquals(Instant.parse("2026-09-22T16:31:07.512Z"), task.lastActivityAt)
        assertEquals(Instant.parse("2026-09-22T16:02:40Z"), task.startedAt)
        assertNull(task.completedAt)

        // `Record<string, unknown>` keeps arbitrary JSON.
        val metadata = assertNotNull(task.metadata)
        assertEquals(JsonPrimitive("c7a04b1e-3f55-4d0a-a0d3-6f1e2b9c8d77"), metadata["taskConfigId"])
        assertEquals(JsonPrimitive(2), metadata["attempt"])
        assertEquals(2, metadata.getValue("labels").jsonArray.size)
        assertEquals(JsonNull, metadata.getValue("nested").jsonObject["none"])

        assertEquals(false, response.stallInfo?.isStalled)
        assertEquals(300000.0, response.stallInfo?.thresholdMs)
    }

    @Test
    fun anUnknownStateDoesNotFailTheTask() {
        val json = Fixtures.text("task.json").replace("\"pr_opened\"", "\"parked_by_a_newer_server\"")
        val task = OptioJson.decodeFromString<TaskResponse>(json).task
        assertEquals(TaskState.UNKNOWN, task.state)
        assertEquals("Fix flaky login test", task.title)
    }

    @Test
    fun aMissingOptionalFieldDecodesAsNull() {
        val json = """
            {"id":"t","title":"x","prompt":"p","repoUrl":"r","repoBranch":"main","state":"queued",
             "agentType":"codex","retryCount":0,"maxRetries":3,
             "createdAt":"2026-09-22T16:02:11Z","updatedAt":"2026-09-22T16:02:11Z"}
        """.trimIndent()
        val task = OptioJson.decodeFromString<OptioTask>(json)
        assertEquals(TaskState.QUEUED, task.state)
        assertNull(task.prUrl)
        assertNull(task.metadata)
        assertNull(task.runTarget)
        assertNull(task.startedAt)
    }
}
