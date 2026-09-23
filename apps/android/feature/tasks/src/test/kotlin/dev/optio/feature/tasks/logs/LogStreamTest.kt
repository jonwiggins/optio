package dev.optio.feature.tasks.logs

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.FakeSocket
import dev.optio.core.ui.log.TaskLogRow
import dev.optio.core.ui.log.TaskLogsEnvelope
import dev.optio.feature.tasks.RealMainRule
import dev.optio.feature.tasks.await
import dev.optio.feature.tasks.eventually
import dev.optio.feature.tasks.fastSockets
import java.time.Instant
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.junit.Rule

/**
 * The log streams against a fake server: REST history then the socket, catch-up replay ignored,
 * duplicates merged, untyped task frames upgraded to typed rows, gaps backfilled after a reconnect
 * and after the screen comes back, a reload after a force redo.
 */
class LogStreamTest {
    @get:Rule val fake = FakeOptioServerRule()

    @get:Rule val main = RealMainRule()

    private val server get() = fake.server
    private var scope: CoroutineScope? = null

    @AfterTest
    fun tearDown() {
        scope?.cancel()
    }

    private val t0 = Instant.parse("2026-09-23T00:46:10.000Z")

    private fun at(ms: Long) = t0.plusMillis(ms).toString()

    /** The server's stored rows; the logs route pages them by offset like the API. */
    private val stored = CopyOnWriteArrayList<TaskLogRow>()

    private fun serveTaskLogs() {
        server.get("/api/tasks/:id/logs") { req ->
            val offset = req.queryParam("offset")?.toInt() ?: 0
            val limit = req.queryParam("limit")?.toInt() ?: 200
            FakeResponse.of(TaskLogsEnvelope(stored.drop(offset).take(limit)))
        }
    }

    private fun serveRunLogs() {
        server.get("/api/workflow-runs/:id/logs") { FakeResponse.of(TaskLogsEnvelope(stored.toList())) }
    }

    private fun store(id: String, content: String, ms: Long, type: String = "text") {
        stored += TaskLogRow(id = id, stream = "stdout", content = content, logType = type, timestamp = at(ms))
    }

    private fun FakeSocket.log(content: String, ms: Long, type: String? = null, catchUp: Boolean = false, event: String = "task:log") = sendText(
        buildJsonObject {
            put("type", event)
            put("taskId", "t1")
            put("workflowRunId", "r1")
            put("stream", "stdout")
            put("content", content)
            put("timestamp", at(ms))
            if (type != null) put("logType", type)
            if (catchUp) put("catchUp", true)
        }.toString(),
    )

    private fun newScope(): CoroutineScope = CoroutineScope(SupervisorJob() + main.dispatcher).also { scope = it }

    private fun LogStream.contents() = entries.value.map { it.content }

    @Test
    fun historyThenLiveWithCatchUpIgnoredAndUntypedFramesUpgraded() = main.onMain {
        serveTaskLogs()
        store("1", "Session started", 0, "system")
        store("2", "hello", 5)
        val endpoint = server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api), upgradeDelay = 150.milliseconds)
        logs.start()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.loaded.await { it }
        assertEquals(listOf("Session started", "hello"), logs.contents())

        // The server's catch-up replay of stored rows is ignored.
        socket.log("Session started", 0, "system", catchUp = true)
        socket.log("hello", 5, "text", catchUp = true)
        // A live tool call arrives untyped (the server doesn't send logType for task:log)…
        socket.log("{\"command\":\"ls\"}", 14)
        logs.entries.await { it.size == 3 }
        assertEquals(AgentLogEntry.TypeValue.TEXT, logs.entries.value.last().type)
        // …and its stored row is typed: the stream swaps it in shortly after.
        store("3", "{\"command\":\"ls\"}", 9, "tool_use")
        logs.entries.await { it.lastOrNull()?.type == AgentLogEntry.TypeValue.TOOL_USE }
        assertEquals(listOf("Session started", "hello", "{\"command\":\"ls\"}"), logs.contents())
        assertEquals(listOf(LogBook.Origin.STORED, LogBook.Origin.STORED, LogBook.Origin.STORED), logs.origins())
        // The upgrade fetched only the tail.
        val tail = server.requests("GET", "/api/tasks/t1/logs").last()
        assertEquals("2", tail.queryParam("offset"))
        logs.stop()
    }

    @Test
    fun framesThatBeatTheFirstFetchAreMergedNotDoubled() = main.onMain {
        store("1", "a", 0)
        store("2", "b", 10)
        // History answers slowly; the socket delivers "b" and "c" first.
        server.get("/api/tasks/:id/logs") { FakeResponse.of(TaskLogsEnvelope(stored.toList())).delayed(400) }
        val endpoint = server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api), upgradeDelay = 10_000.milliseconds)
        logs.start()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        socket.log("b", 12)
        socket.log("c", 20)
        delay(100)
        assertTrue(logs.entries.value.isEmpty(), "nothing shows before history lands")
        logs.loaded.await { it }
        logs.entries.await { it.size == 3 }
        assertEquals(listOf("a", "b", "c"), logs.contents())
        logs.stop()
    }

    @Test
    fun aReconnectBackfillsWhatWasPrintedWhileTheSocketWasDown() = main.onMain {
        serveTaskLogs()
        store("1", "a", 0)
        val endpoint = server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api), upgradeDelay = 10_000.milliseconds)
        logs.start()
        val first = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.loaded.await { it }
        logs.connected.await { it }

        // The connection drops (not a permanent close code) and two lines are printed meanwhile.
        first.close(1011, "restart")
        logs.connected.await { !it }
        store("2", "b", 10)
        store("3", "c", 20)
        val second = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.entries.await { it.size == 3 }
        assertEquals(listOf("a", "b", "c"), logs.contents())
        assertEquals("1", server.requests("GET", "/api/tasks/t1/logs").last().queryParam("offset"))

        // The new socket's live copy of a backfilled line is absorbed; a new line is appended.
        second.log("c", 23)
        second.log("d", 30)
        logs.entries.await { it.size == 4 }
        delay(150)
        assertEquals(listOf("a", "b", "c", "d"), logs.contents())
        logs.stop()
    }

    @Test
    fun leavingClosesTheSocketAndComingBackBackfills() = main.onMain {
        serveTaskLogs()
        store("1", "a", 0)
        val endpoint = server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api), upgradeDelay = 10_000.milliseconds)
        logs.start()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.entries.await { it.size == 1 }

        logs.stop()
        assertTrue(!logs.connected.value)
        eventually { socket.closed != null }
        assertEquals(1000, socket.closed!!.first, "a normal close, no reconnect")

        store("2", "b", 10)
        logs.start()
        withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.entries.await { it.size == 2 }
        assertEquals(listOf("a", "b"), logs.contents())
        assertEquals(2, endpoint.connections.size)
        logs.stop()
    }

    @Test
    fun reloadStartsOverAfterAForceRedo() = main.onMain {
        serveTaskLogs()
        store("1", "old a", 0)
        store("2", "old b", 10)
        val api = server.client()
        server.webSocket("/ws/logs/:taskId")
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api))
        logs.start()
        logs.entries.await { it.size == 2 }
        stored.clear()
        store("9", "fresh", 100)
        logs.reload()
        logs.entries.await { it.map { e -> e.content } == listOf("fresh") }
        logs.stop()
    }

    @Test
    fun stateFramesAreReported() = main.onMain {
        serveTaskLogs()
        val endpoint = server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api))
        val changed = async { logs.stateChanges.first() }
        logs.start()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        socket.sendText("""{"type":"task:state_changed","taskId":"t1","fromState":"running","toState":"pr_opened","timestamp":"${at(0)}"}""")
        assertEquals("task:state_changed", changed.await())
        logs.stop()
    }

    @Test
    fun appendLocalShowsTheSentMessageAsYou() = main.onMain {
        serveTaskLogs()
        store("1", "a", 0)
        server.webSocket("/ws/logs/:taskId")
        val api = server.client()
        val logs = TaskLogStream(api, "t1", newScope(), fastSockets(api))
        logs.start()
        logs.entries.await { it.size == 1 }
        logs.appendLocal("please also update the docs", interrupt = false)
        val you = logs.entries.await { it.size == 2 }.last()
        assertEquals("please also update the docs", you.content)
        assertEquals("user", (you.metadata!!["role"] as kotlinx.serialization.json.JsonPrimitive).content)
        logs.stop()
    }

    @Test
    fun runLogsRefetchWholeAndDedupeById() = main.onMain {
        serveRunLogs()
        store("1", "Session started", 0, "system")
        val endpoint = server.webSocket("/ws/workflow-runs/:id/logs")
        val api = server.client()
        val logs = RunLogStream(api, "r1", newScope(), fastSockets(api))
        logs.start()
        val first = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.entries.await { it.size == 1 }

        // Run frames are typed and carry the row's own timestamp.
        first.log("Working", 10, "text", event = "workflow_run:log")
        first.log("Session started", 0, "system", catchUp = true, event = "workflow_run:log")
        logs.entries.await { it.size == 2 }

        // A drop, lines printed meanwhile, a reconnect: the whole log is refetched and merged by id.
        store("2", "Working", 10)
        store("3", "Done", 20)
        first.close(1011, "restart")
        withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        logs.entries.await { it.size == 3 }
        delay(150)
        assertEquals(listOf("Session started", "Working", "Done"), logs.contents())
        assertTrue(server.requests("GET", "/api/workflow-runs/r1/logs").size >= 2)
        logs.stop()
    }
}
