package dev.optio.core.testing

import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.OptioJson
import dev.optio.core.model.OptioTask
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.Workflow
import dev.optio.core.model.WorkflowRun
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.junit.Rule

/** The test harness itself: routing, recording, WebSockets, fixtures, samples. */
class FakeOptioServerTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    @Serializable
    internal data class Retry(val reason: String)

    @Test
    fun routesMatchPatternsAndTheNewestWins() = runTest {
        server.json("/api/tasks/:id", """{"id":"generic"}""")
        server.get("/api/tasks/:id") { req -> FakeResponse.json("""{"id":"${req.pathParams["id"]}"}""") }
        server.post("/api/tasks/:id/retry") { req -> FakeResponse.of(Retry(req.bodyAs<Retry>().reason + "!")) }
        val api = server.client(token = "t0k", workspaceId = "ws-9")

        val got = api.get<JsonObject>("/api/tasks/abc", query = mapOf("include" to "logs"))
        assertEquals("abc", got["id"]?.stringValue)
        val retried = api.post<Retry>("/api/tasks/abc/retry", body = Retry("flaky"))
        assertEquals("flaky!", retried.reason)

        val first = server.requests.first()
        assertEquals("GET", first.method)
        assertEquals("/api/tasks/abc", first.path)
        assertEquals("logs", first.queryParam("include"))
        assertEquals("Bearer t0k", first.header("Authorization"))
        assertEquals("ws-9", first.header("x-workspace-id"))
        assertEquals("flaky", server.lastRequest("POST", "/api/tasks/:id/retry")!!.json.jsonObject["reason"]?.stringValue)
        assertEquals(1, server.count("POST"))
        assertEquals(2, server.count(path = "/api/tasks/*"))
    }

    @Test
    fun unmatchedRequestsAndErrorsReadLikeTheApi() = runTest {
        val api = server.client()
        val missing = assertFailsWith<ApiError> { api.get<JsonObject>("/api/nope") }
        assertEquals(404, missing.status)
        assertEquals("No route for GET /api/nope", missing.message)

        server.error("GET", "/api/workspaces", 401, "Unauthorized")
        val denied = assertFailsWith<ApiError> { api.get<JsonObject>("/api/workspaces") }
        assertTrue(denied.isUnauthorized)

        server.get("/api/boom") { error("handler exploded") }
        assertEquals(500, assertFailsWith<ApiError> { api.get<JsonObject>("/api/boom") }.status)
    }

    @Test
    fun awaitRequestBlocksUntilTheCallArrives() = runTest {
        server.json("/api/ping", "{}")
        val api = server.client()
        api.get<JsonObject>("/api/ping")
        assertEquals("/api/ping", server.awaitRequest("GET", "/api/ping").path)
        assertFailsWith<AssertionError> { server.awaitRequest("POST", "/api/ping", timeoutMs = 200) }
        server.clearRequests()
        assertEquals(0, server.count())
    }

    @Test
    fun webSocketsConnectAndTalkBothWays() {
        val endpoint = server.webSocket("/ws/events")
        val received = LinkedBlockingQueue<String>()
        val client = OkHttpClient()
        val socket = client.newWebSocket(
            Request.Builder().url(server.wsUrl("/ws/events")).header("Sec-WebSocket-Protocol", "optio-ws-v1, optio-auth-abc").build(),
            object : WebSocketListener() {
                override fun onMessage(webSocket: WebSocket, text: String) {
                    received += text
                }

                override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                    received += "closed:$code"
                }

                override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                    received += "failure:${t.message}"
                }
            },
        )
        val serverSide = endpoint.awaitConnection()
        assertEquals("optio-ws-v1, optio-auth-abc", serverSide.request.header("Sec-WebSocket-Protocol"))
        socket.send("""{"type":"subscribe"}""")
        assertEquals("""{"type":"subscribe"}""", serverSide.awaitText())
        serverSide.sendText("""{"type":"task:state_changed"}""")
        assertEquals("""{"type":"task:state_changed"}""", received.poll(5, TimeUnit.SECONDS))
        serverSide.close(4401, "unauthorized")
        assertEquals("closed:4401", received.poll(5, TimeUnit.SECONDS))
        assertEquals(1, endpoint.connections.size)
        client.dispatcher.executorService.shutdown()
    }

    @Test
    fun sharedFixturesLoadAndDecode() {
        Fixtures.SHARED.forEach { name -> assertTrue(Fixtures.text(name).isNotBlank(), name) }
        assertEquals("local", Fixtures.json("auth-me.json").jsonObject["user"]!!.jsonObject["id"]?.stringValue)
        assertFailsWith<IllegalStateException> { Fixtures.text("no-such-fixture.json") }
    }

    @Test
    fun samplesRoundTripThroughTheWireFormat() {
        fun <T> roundTrip(value: T, serializer: kotlinx.serialization.KSerializer<T>) =
            assertEquals(value, OptioJson.decodeFromString(serializer, OptioJson.encodeToString(serializer, value)))
        roundTrip(Samples.task(), OptioTask.serializer())
        roundTrip(Samples.workflow(), Workflow.serializer())
        roundTrip(Samples.workflowRun(), WorkflowRun.serializer())
        roundTrip(Samples.persistentAgent(), PersistentAgent.serializer())
        roundTrip(Samples.localTerminal(), LocalTerminal.serializer())
        assertEquals(10, Samples.transcript().size)
        assertNotNull(Samples.localHost(codex = Samples.codexLimits()).agentLimits?.codex)
        assertEquals("2026-09-22T16:38:00Z", Samples.agoIso(2))
    }
}
