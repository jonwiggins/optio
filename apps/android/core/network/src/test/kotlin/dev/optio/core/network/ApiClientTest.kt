package dev.optio.core.network

import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.TaskState
import java.time.Instant
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest

/** Port of iOS `APIClientTests` plus the request/response contract (headers, query, bodies, errors). */
class ApiClientTest {
    private lateinit var server: MockWebServer
    private lateinit var api: ApiClient

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
        api = ApiClient(baseUrl = server.url("/").toString(), token = "optio_pat_test")
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    private fun enqueue(
        body: String = "{}",
        code: Int = 200,
    ) = server.enqueue(MockResponse.Builder().code(code).body(body).build())

    private fun take(): RecordedRequest = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)) { "no request" }

    @Serializable
    data class Row(val id: String, val count: Int = 0)

    @Serializable
    data class Body(val name: String, val note: String? = null)

    // region iOS APIClientTests

    @Test
    fun wsUrlSwapsScheme() {
        val client = ApiClient(baseUrl = "https://optio.example:30400", token = "t")
        assertEquals("wss://optio.example:30400/ws/events", client.wsUrl("/ws/events"))
        client.configure("http://mac.tail.ts.net:30400", "t", null)
        assertEquals("ws://mac.tail.ts.net:30400/ws/events", client.wsUrl("/ws/events"))
    }

    @Serializable
    data class Dated(
        @Serializable(with = FlexibleInstantSerializer::class) val at: Instant,
    )

    @Test
    fun dateDecoding() =
        runTest {
            enqueue("""{"at":"2026-09-17T10:20:30.123Z"}""")
            assertEquals(Instant.parse("2026-09-17T10:20:30.123Z"), api.get<Dated>("/d").at)
            enqueue("""{"at":"2026-09-17T10:20:30Z"}""")
            assertEquals(Instant.parse("2026-09-17T10:20:30Z"), api.get<Dated>("/d").at)
            enqueue("""{"at":1789640430123}""")
            assertEquals(Instant.ofEpochMilli(1789640430123), api.get<Dated>("/d").at)
            enqueue("""{"at":"yesterday"}""")
            val error = assertFailsWith<ApiError> { api.get<Dated>("/d") }
            assertTrue(error.isDecodingFailure, error.message)
        }

    // endregion

    // region URLs and headers

    @Test
    fun sendsBearerWorkspaceAndAcceptHeaders() =
        runTest {
            api.workspaceId = "ws-1"
            enqueue("""{"id":"r1"}""")
            api.get<Row>("/api/rows/r1")
            val request = take()
            assertEquals("GET", request.method)
            assertEquals("/api/rows/r1", request.url.encodedPath)
            assertEquals("Bearer optio_pat_test", request.headers["Authorization"])
            assertEquals("ws-1", request.headers["x-workspace-id"])
            assertEquals("application/json", request.headers["Accept"])
            assertNull(request.headers["Content-Type"])
        }

    @Test
    fun omitsWorkspaceHeaderWhenUnset() =
        runTest {
            enqueue("""{"id":"r1"}""")
            api.get<Row>("/api/rows/r1")
            assertNull(take().headers["x-workspace-id"])
        }

    @Test
    fun queryEncoding() =
        runTest {
            enqueue("""{"id":"r1"}""")
            api.get<Row>(
                "/api/tasks",
                query =
                    mapOf(
                        "q" to "fix login & signup",
                        "limit" to 50,
                        "skip" to null,
                        "state" to TaskState.PR_OPENED,
                        "archived" to false,
                        "repo" to listOf("a", "b"),
                    ),
            )
            val url = take().url
            assertEquals("fix login & signup", url.queryParameter("q"))
            assertEquals("50", url.queryParameter("limit"))
            assertNull(url.queryParameter("skip"))
            assertEquals("pr_opened", url.queryParameter("state"))
            assertEquals("false", url.queryParameter("archived"))
            assertEquals(listOf("a", "b"), url.queryParameterValues("repo"))
            assertEquals("q=fix%20login%20%26%20signup&limit=50&state=pr_opened&archived=false&repo=a&repo=b", url.encodedQuery)
        }

    @Test
    fun urlKeepsTheBasePathAndAnInlineQuery() {
        val client = ApiClient(baseUrl = "https://host.example/optio/", token = "t")
        assertEquals("https://host.example/optio/api/tasks/a%20b", client.url("/api/tasks/a b").toString())
        assertEquals(
            "https://host.example/optio/api/tasks?limit=5&state=running",
            client.url("/api/tasks?limit=5", mapOf("state" to "running")).toString(),
        )
        val bare = ApiClient(baseUrl = "http://10.0.2.2:4971", token = "t")
        assertEquals("http://10.0.2.2:4971/api/auth/me", bare.url("/api/auth/me").toString())
        assertEquals("ws://10.0.2.2:4971/ws/logs/t1", bare.wsUrl("/ws/logs/t1"))
    }

    @Test
    fun unconfiguredClientFailsWithApiError() =
        runTest {
            val client = ApiClient()
            assertFalse(client.isConfigured)
            val error = assertFailsWith<ApiError> { client.get<Row>("/api/rows") }
            assertEquals(0, error.status)
            assertFalse(ApiClient(baseUrl = "not a url", token = "t").isConfigured)
        }

    // endregion

    // region Bodies

    @Test
    fun postEncodesASerializableBody() =
        runTest {
            enqueue("""{"id":"r1","count":2}""")
            val row = api.post<Row>("/api/rows", body = Body(name = "Fix"))
            assertEquals(Row("r1", 2), row)
            val request = take()
            assertEquals("POST", request.method)
            assertEquals("application/json", request.headers["Content-Type"])
            assertEquals("""{"name":"Fix"}""", request.body?.utf8())
        }

    @Test
    fun postWithoutABodySendsAnEmptyBodyWithoutContentType() =
        runTest {
            enqueue("")
            api.post("/api/tasks/t1/retry")
            val request = take()
            assertEquals("POST", request.method)
            assertEquals(0L, request.bodySize)
            assertNull(request.headers["Content-Type"])
        }

    @Test
    fun mapAndJsonElementBodiesCanSendExplicitNulls() =
        runTest {
            enqueue()
            api.patch<Unit>("/api/repos/r1", body = mapOf("reviewModel" to null, "maxAgents" to 3, "tags" to listOf("a")))
            assertEquals("""{"reviewModel":null,"maxAgents":3,"tags":["a"]}""", take().body?.utf8())

            enqueue()
            api.put<Unit>("/api/x", body = buildJsonObject { put("description", JsonNull) })
            val request = take()
            assertEquals("PUT", request.method)
            assertEquals("""{"description":null}""", request.body?.utf8())
        }

    @Serializable
    private data class PrivateBody(val data: String)

    @Test
    fun privateSerializableClassesWorkAsBodies() =
        runTest {
            enqueue()
            api.post("/api/local/terminals/t1/input", body = PrivateBody("ls\r"))
            assertEquals("""{"data":"ls\r"}""", take().body?.utf8())
        }

    @Test
    fun localSerializableClassesWorkAsBodies() =
        runTest {
            @Serializable
            data class Local(val prompt: String)
            enqueue()
            api.post("/api/x", body = Local("hi"))
            assertEquals("""{"prompt":"hi"}""", take().body?.utf8())
        }

    @Test
    fun aBodyThatIsNotSerializableFailsLoudly() =
        runTest {
            class NotSerializable(val x: Int)
            val error = assertFailsWith<IllegalArgumentException> { api.post("/api/x", body = NotSerializable(1)) }
            assertTrue(error.message!!.contains("not @Serializable"), error.message)
        }

    @Test
    fun deleteAndFireAndForgetVariants() =
        runTest {
            enqueue("""{"ok":true}""")
            api.delete("/api/secrets/s1")
            val request = take()
            assertEquals("DELETE", request.method)
            assertEquals(0L, request.bodySize)

            enqueue("""{"id":"r1"}""")
            val typed: Row = api.delete<Row>("/api/rows/r1")
            assertEquals("r1", typed.id)
        }

    // endregion

    // region Responses and errors

    @Test
    fun unitIgnoresTheBodyAndNullableTreatsEmptyAsNull() =
        runTest {
            enqueue("not json at all")
            api.get<Unit>("/api/x")
            server.enqueue(MockResponse.Builder().code(204).build())
            assertNull(api.get<Row?>("/api/x"))
        }

    @Test
    fun errorMessagesComeFromErrorThenMessageThenTheStatus() =
        runTest {
            enqueue("""{"error":"Task not found","message":"ignored"}""", code = 404)
            val notFound = assertFailsWith<ApiError> { api.get<Row>("/api/tasks/x") }
            assertEquals(404, notFound.status)
            assertEquals("Task not found", notFound.message)
            assertEquals("""{"error":"Task not found","message":"ignored"}""", notFound.body)
            assertEquals("Task not found (HTTP 404)", notFound.description)

            enqueue("""{"message":"Body cannot be empty"}""", code = 400)
            assertEquals("Body cannot be empty", assertFailsWith<ApiError> { api.get<Row>("/x") }.message)

            enqueue("<html>Bad Gateway</html>", code = 502)
            assertEquals("bad gateway", assertFailsWith<ApiError> { api.get<Row>("/x") }.message)

            enqueue("", code = 418)
            assertEquals("client error", assertFailsWith<ApiError> { api.get<Row>("/x") }.message)
        }

    @Test
    fun a401CallsOnUnauthorizedBeforeThrowing() =
        runTest {
            val calls = AtomicInteger()
            api.onUnauthorized = { calls.incrementAndGet() }
            enqueue("""{"error":"Invalid or expired session"}""", code = 401)
            val error = assertFailsWith<ApiError> { api.get<Row>("/api/tasks") }
            assertTrue(error.isUnauthorized)
            assertEquals("Invalid or expired session", error.message)
            assertEquals(1, calls.get())

            enqueue("""{"error":"Forbidden"}""", code = 403)
            assertFailsWith<ApiError> { api.get<Row>("/api/tasks") }
            assertEquals(1, calls.get(), "only 401 calls back")
        }

    @Test
    fun decodingFailuresAreStatusZero() =
        runTest {
            enqueue("""{"unexpected":true}""")
            val error = assertFailsWith<ApiError> { api.get<Row>("/api/rows/r1") }
            assertEquals(0, error.status)
            assertTrue(error.isDecodingFailure)
            assertFalse(error.isTransportFailure)
            assertTrue(error.message.startsWith("Decoding Row failed"), error.message)
            assertEquals("""{"unexpected":true}""", error.body)
        }

    @Test
    fun transportFailuresAreStatusZero() =
        runTest {
            val port = server.port
            server.close()
            val client = ApiClient(baseUrl = "http://127.0.0.1:$port", token = "t")
            val error = assertFailsWith<ApiError> { client.get<Row>("/api/rows") }
            assertEquals(0, error.status)
            assertTrue(error.isTransportFailure)
            assertEquals("Could not connect to the server.", error.message)
        }

    // endregion

    // region Auth endpoints

    @Test
    fun currentUserMapsWorkspaceRoleAndAuthDisabled() =
        runTest {
            enqueue(
                """{"user":{"id":"u1","provider":"github","email":"a@b.c","displayName":"Ada","username":null,
                   "avatarUrl":null,"workspaceId":"ws-1","workspaceRole":"viewer"},"authDisabled":false}""",
            )
            val viewer = api.currentUser()
            assertEquals("/api/auth/me", take().url.encodedPath)
            assertEquals("viewer", viewer.role)
            assertEquals("ws-1", viewer.workspaceId)
            assertFalse(viewer.canMutate)
            assertFalse(viewer.isAdmin)

            enqueue("""{"user":{"id":"u1","workspaceRole":"member"},"authDisabled":false}""")
            val member = api.currentUser()
            assertTrue(member.canMutate)
            assertFalse(member.isAdmin)

            enqueue("""{"user":{"id":"u1","workspaceRole":"admin"}}""")
            assertTrue(api.currentUser().isAdmin)

            // Auth-disabled dev servers send no role, and allow everything.
            enqueue(
                """{"user":{"id":"local","provider":"local","email":"dev@localhost","displayName":"Local Dev",
                   "username":null,"avatarUrl":null},"authDisabled":true}""",
            )
            val dev = api.currentUser()
            assertNull(dev.role)
            assertTrue(dev.authDisabled)
            assertTrue(dev.canMutate)
            assertTrue(dev.isAdmin)
            assertEquals("Local Dev", dev.label)
        }

    @Test
    fun wsTokenReadsTheToken() =
        runTest {
            enqueue("""{"token":"abc123"}""")
            assertEquals("abc123", api.wsToken())
            assertEquals("/api/auth/ws-token", take().url.encodedPath)
        }

    // endregion
}
