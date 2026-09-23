package dev.optio.core.data

import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.network.EventHub
import dev.optio.core.network.WebSocketClient
import dev.optio.core.network.WsFrame
import dev.optio.core.network.on
import java.io.File
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.firstOrNull
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assume.assumeTrue

/**
 * The auth endpoints, sockets and session against the private test API (PLAN §6, §8). Skipped
 * unless `OPTIO_TEST_API_URL` is set (e.g. `http://127.0.0.1:4971`); the seed manifest comes from
 * `OPTIO_TEST_SEED`, else `apps/android/e2e/.run/<port>/seed.json` of the instance.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4971 ./gradlew :core:data:testDebugUnitTest --tests '*LiveApiTest*'
 * ```
 */
class LiveApiTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @AfterTest
    fun tearDown() = scope.cancel()

    private fun seed(): JsonObject {
        val url = checkNotNull(baseUrl)
        val port = url.substringAfterLast(':').takeWhile { it.isDigit() }
        val candidates =
            listOfNotNull(
                System.getenv("OPTIO_TEST_SEED"),
                File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path,
            )
        val file = candidates.map(::File).firstOrNull { it.isFile } ?: error("no seed.json for $url (set OPTIO_TEST_SEED)")
        return kotlinx.serialization.json.Json.parseToJsonElement(file.readText()).jsonObject
    }

    private val JsonObject.authEnabled: Boolean
        get() = this["auth"]?.get("enabled")?.jsonPrimitive?.content == "true"

    private fun JsonObject.token(role: String): String = checkNotNull(this["auth"]?.get("${role}Token")?.stringValue)

    @Test
    fun rolesFromTheRealApi() =
        runBlocking<Unit> {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val seed = seed()
            if (!seed.authEnabled) {
                val dev = ApiClient(baseUrl, "dev").currentUser()
                assertTrue(dev.authDisabled)
                assertTrue(dev.canMutate && dev.isAdmin, "auth disabled allows everything")
                return@runBlocking
            }
            val admin = ApiClient(baseUrl, seed.token("admin")).currentUser()
            assertEquals("admin", admin.role)
            assertTrue(admin.isAdmin && admin.canMutate)
            assertEquals("ada-admin@example.com", admin.email)

            val member = ApiClient(baseUrl, seed.token("member")).currentUser()
            assertEquals("member", member.role)
            assertTrue(member.canMutate)
            assertFalse(member.isAdmin)

            val viewer = ApiClient(baseUrl, seed.token("viewer")).currentUser()
            assertEquals("viewer", viewer.role)
            assertFalse(viewer.canMutate)
            assertFalse(viewer.isAdmin)

            val rejected = assertFailsWith<ApiError> { ApiClient(baseUrl, "optio_pat_not_a_real_token").currentUser() }
            assertTrue(rejected.isUnauthorized)

            // A viewer's write is refused by the server too (the UI gating is only a courtesy).
            val job = mapOf("name" to "viewer job", "promptTemplate" to "nope", "agentRuntime" to "claude-code")
            val forbidden = assertFailsWith<ApiError> { ApiClient(baseUrl, seed.token("viewer")).post("/api/jobs", body = job) }
            assertEquals(403, forbidden.status)
        }

    @Test
    fun theSessionPairsAndRejectsLikeTheForm() =
        runBlocking<Unit> {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val seed = seed()
            val session = SessionStore(ServerRegistry.inMemory(), scope)
            session.restore()
            if (seed.authEnabled) {
                val error = assertFailsWith<ApiError> { session.addServer(baseUrl!!, "optio_pat_not_a_real_token") }
                assertTrue(error.isUnauthorized)
                assertEquals(SessionStore.Phase.SIGNED_OUT, session.phase.value)
            }
            val token = if (seed.authEnabled) seed.token("member") else "dev"
            session.addServer(baseUrl!!, token, name = "Test API")
            assertEquals(SessionStore.Phase.SIGNED_IN, session.phase.value)
            assertEquals(if (seed.authEnabled) "member" else null, session.user.value?.role)
            assertTrue(session.user.value!!.canMutate)

            // The one events socket connects with a ws-token and replays recent state changes.
            withTimeout(15_000) { session.events.connected.first { it } }
        }

    @Test
    fun socketsAuthenticateWithAWsTokenOrThePat() =
        runBlocking<Unit> {
            assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
            val seed = seed()
            val token = if (seed.authEnabled) seed.token("admin") else "dev"
            val api = ApiClient(baseUrl, token)

            // ws-token first (the ApiClient constructor), catch-up frames decode as events.
            val hub = EventHub(api)
            try {
                val catchUp = scope.async { withTimeout(15_000) { hub.on<TaskStateChangedEvent>().first() } }
                hub.start()
                assertTrue(catchUp.await().taskId.isNotEmpty())
            } finally {
                hub.stop()
            }

            // The PAT itself in the subprotocol slot works too.
            val ws = WebSocketClient(url = api.wsUrl(EventHub.PATH), tokenProvider = { token }, autoReconnect = false)
            try {
                ws.connect()
                val first = withTimeout(15_000) { ws.frames.firstOrNull { it !is WsFrame.Opened } }
                assertIs<WsFrame.Json>(first)
                assertEquals("task:state_changed", first.value["type"]?.stringValue)
            } finally {
                ws.disconnect()
            }

            if (seed.authEnabled) {
                // A bad token is refused with 4401 and never retried.
                val bad = WebSocketClient(url = api.wsUrl(EventHub.PATH), tokenProvider = { "optio_pat_not_a_real_token" })
                try {
                    bad.connect()
                    val closed = withTimeout(15_000) { bad.frames.first { it is WsFrame.Closed } }
                    assertEquals(WsFrame.Closed(4401, "Invalid or expired session"), closed)
                } finally {
                    bad.disconnect()
                }
            }
        }
}
