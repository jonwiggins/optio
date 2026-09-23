package dev.optio.feature.reviews

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.network.WebSocketClient
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicReference
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.asCoroutineDispatcher
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Rule

/**
 * [RunLogStream] over a real `WebSocketClient` against the fake API: REST backfill + live frames,
 * catch-up replay skipped, echoes of history rows dropped, state frames forwarded, reconnects
 * refilled from history. The stream runs on one thread, as it does on Main in the app.
 */
class RunLogStreamTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val executor = Executors.newSingleThreadExecutor()
    private val scope = CoroutineScope(SupervisorJob() + executor.asCoroutineDispatcher())
    private val wsPath = "/ws/pr-reviews/r1/logs"

    @After
    fun tearDown() {
        scope.cancel()
        executor.shutdownNow()
    }

    private fun stream(reconnect: kotlin.time.Duration = 3_000.milliseconds): RunLogStream {
        val api = server.client()
        return RunLogStream(
            scope = scope,
            logEventType = "pr_review_run:log",
            stateEventTypes = setOf("pr_review:state_changed", "pr_review_run:state_changed", "pr_review:stale"),
            openSocket = { path ->
                WebSocketClient(url = api.wsUrl(path), tokenProvider = { "tok" }, reconnectDelay = reconnect, sendHold = 0.milliseconds)
            },
        ).also { s -> scope.launch { s.start(wsPath) { api.prReviewLogs("r1").map { it.toLogEntry() } } } }
    }

    private fun frame(content: String, timestamp: String, extra: String = "") =
        """{"type":"pr_review_run:log","prReviewId":"r1","runId":"run-initial-1","stream":"stdout","content":"$content","timestamp":"$timestamp","logType":"text"$extra}"""

    @Test
    fun historyThenLiveWithCatchUpSkippedAndEchoesDropped() = runBlocking {
        server.fixture("/api/pr-reviews/r1/logs", "pr-review-logs.json")
        val endpoint = server.webSocket(wsPath)
        val stream = stream()
        val socket = endpoint.awaitConnection()
        withTimeout(5_000) { stream.connected.first { it } }
        assertTrue(socket.request.header("Sec-WebSocket-Protocol")!!.contains("optio-auth-tok"))
        // The server's catch-up replay of a stored row: ignored (history is canonical).
        socket.sendText(frame("Reviewing e2e-org/e2e-repo#138 at c41d0a9", "2026-09-22T16:06:12.114Z", ""","catchUp":true"""))
        withTimeout(5_000) { stream.entries.first { it.size == 4 } }
        // A late echo of the last stored row (the worker stamps its frame a few ms after the insert).
        socket.sendText(
            """{"type":"pr_review_run:log","prReviewId":"r1","runId":"run-initial-1","stream":"stdout","content":"The pagination works, but **offset** is never reset when a filter changes.","timestamp":"2026-09-22T16:30:58.061Z","logType":"text"}""",
        )
        socket.sendText(frame("New finding", "2026-09-22T16:31:30.000Z"))
        val entries = withTimeout(5_000) { stream.entries.first { it.size == 5 } }
        assertEquals("New finding", entries.last().content)
        assertEquals(AgentLogEntry.TypeValue.TEXT, entries.last().type)
        assertEquals(1, entries.count { it.content.startsWith("The pagination works") }, "the echo is dropped")
        assertEquals(1, entries.count { it.content.startsWith("Reviewing") }, "the catch-up replay is skipped")
        stream.stop()
        assertFalse(stream.connected.value)
    }

    @Test
    fun framesThatArriveWhileHistoryLoadsAreMergedOnce() = runBlocking {
        val endpoint = server.webSocket(wsPath)
        // History answers slowly, so the live frames arrive first and wait in the buffer.
        server.on("GET", "/api/pr-reviews/r1/logs") { FakeResponse.fixture("pr-review-logs.json").delayed(600) }
        val stream = stream()
        val socket = endpoint.awaitConnection()
        withTimeout(5_000) { stream.connected.first { it } }
        socket.sendText(frame("draft saved", "2026-09-22T16:31:04.950Z").replace("\"logType\":\"text\"", "\"logType\":\"checkpoint\""))
        socket.sendText(frame("Live only", "2026-09-22T16:32:00.000Z"))
        val entries = withTimeout(5_000) { stream.entries.first { it.size >= 5 } }
        assertEquals(
            listOf("Reviewing e2e-org/e2e-repo#138 at c41d0a9", "{\"file_path\":\"apps/web/src/app/activity/page.tsx\"}", "The pagination works, but **offset** is never reset when a filter changes.", "draft saved", "Live only"),
            entries.map { it.content },
            "the buffered echo of the stored checkpoint row merges into it",
        )
    }

    @Test
    fun stateFramesAreForwardedNotLogged() = runBlocking {
        server.json("/api/pr-reviews/r1/logs", """{"logs":[]}""")
        val endpoint = server.webSocket(wsPath)
        val stream = stream()
        val socket = endpoint.awaitConnection()
        withTimeout(5_000) { stream.connected.first { it } }
        val received = CompletableDeferred<String>()
        scope.launch { received.complete(stream.stateChanges.first()) }
        delay(100) // let the collector subscribe (no replay)
        socket.sendText("""{"type":"pr_review:state_changed","prReviewId":"r1","fromState":"reviewing","toState":"ready","trigger":"agent_done","timestamp":"2026-09-22T16:31:05.000Z"}""")
        assertEquals("pr_review:state_changed", withTimeout(5_000) { received.await() })
        assertTrue(stream.entries.value.isEmpty())
    }

    @Test
    fun aReconnectRefillsWhatWasLoggedWhileTheSocketWasDown() = runBlocking {
        val rows = AtomicReference("""{"logs":[{"content":"one","logType":"text","timestamp":"2026-09-22T16:00:00.000Z"}]}""")
        server.on("GET", "/api/pr-reviews/r1/logs") { FakeResponse.json(rows.get()) }
        val endpoint = server.webSocket(wsPath)
        val stream = stream(reconnect = 100.milliseconds)
        val first = endpoint.awaitConnection()
        withTimeout(5_000) { stream.entries.first { it.size == 1 } }
        // Two lines are logged while the socket is down; only history knows them.
        rows.set(
            """{"logs":[
            {"content":"one","logType":"text","timestamp":"2026-09-22T16:00:00.000Z"},
            {"content":"two","logType":"text","timestamp":"2026-09-22T16:00:01.000Z"},
            {"content":"three","logType":"text","timestamp":"2026-09-22T16:00:02.000Z"}]}""",
        )
        first.close(1001, "going away")
        endpoint.awaitConnection()
        val entries = withTimeout(5_000) { stream.entries.first { it.size == 3 } }
        assertEquals(listOf("one", "two", "three"), entries.map { it.content })
        assertEquals(2, server.count("GET", "/api/pr-reviews/r1/logs"))
    }

    @Test
    fun aFailedHistoryKeepsTheLiveLinesAndSaysWhy() = runBlocking {
        server.error("GET", "/api/pr-reviews/r1/logs", 500, "boom")
        server.webSocket(wsPath)
        val stream = stream()
        val error = withTimeout(5_000) { stream.error.first { it != null } }
        assertTrue(error!!.message!!.contains("boom"))
        assertTrue(stream.entries.value.isEmpty())
    }
}
