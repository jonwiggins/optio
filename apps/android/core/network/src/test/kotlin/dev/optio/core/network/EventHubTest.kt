package dev.optio.core.network

import app.cash.turbine.test
import app.cash.turbine.turbineScope
import dev.optio.core.model.ActivityNewEvent
import dev.optio.core.model.TaskState
import dev.optio.core.model.TaskStateChangedEvent
import dev.optio.core.model.WsEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/** EventHub over a real socket to MockWebServer: per-frame decoding, fan-out, connected state, start/stop. */
class EventHubTest {
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

    /** A hub whose socket skips the ws-token round trip (the PAT rides in the subprotocol). */
    private fun hub() =
        EventHub(
            api = api,
            socketFactory = { client ->
                WebSocketClient(
                    url = client.wsUrl(EventHub.PATH),
                    tokenProvider = { client.token },
                    reconnectDelay = 100.milliseconds,
                )
            },
        )

    private fun enqueueEvents(vararg frames: String) =
        server.enqueue(
            MockResponse.Builder()
                .webSocketUpgrade(
                    object : WebSocketListener() {
                        override fun onOpen(
                            webSocket: WebSocket,
                            response: Response,
                        ) {
                            // Give collectors a moment to subscribe after `connected` flips.
                            Thread.sleep(150)
                            frames.forEach(webSocket::send)
                        }

                        override fun onClosing(
                            webSocket: WebSocket,
                            code: Int,
                            reason: String,
                        ) {
                            webSocket.close(1000, null)
                        }
                    },
                ).build(),
        )

    private val stateChanged =
        """{"type":"task:state_changed","taskId":"t1","fromState":"running","toState":"pr_opened",
           "timestamp":"2026-09-22T16:31:07.512Z","catchUp":true}"""

    @Test
    fun decodesEveryFrameAndNeverDropsOne() =
        runTest {
            enqueueEvents(
                stateChanged,
                """{"type":"local:changed","terminalId":"lt1","hostId":"h1","userId":null}""",
                // A known type that does not decode (toState missing) still arrives, raw.
                """{"type":"task:state_changed","taskId":"t2"}""",
                "not json",
                """{"type":"activity:new","action":"task.created","resourceType":"task","summary":"s","timestamp":"2026-09-22T16:02:11.004Z"}""",
            )
            val hub = hub()
            hub.events.test {
                hub.start()
                val changed = assertIs<TaskStateChangedEvent>(awaitItem())
                assertEquals("t1", changed.taskId)
                assertEquals(TaskState.PR_OPENED, changed.toState)

                val local = assertIs<WsEvent.Unknown>(awaitItem())
                assertEquals("local:changed", local.raw["type"]?.stringValue)

                val malformed = assertIs<WsEvent.Unknown>(awaitItem())
                assertEquals("t2", malformed.raw["taskId"]?.stringValue)

                // "not json" is skipped; the next event still arrives.
                assertEquals("task.created", assertIs<ActivityNewEvent>(awaitItem()).action)
                hub.stop()
                cancelAndIgnoreRemainingEvents()
            }
            val upgrade = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS))
            assertEquals("/ws/events", upgrade.url.encodedPath)
            assertEquals("optio-ws-v1, optio-auth-optio_pat_test", upgrade.headers["Sec-WebSocket-Protocol"])
        }

    @Test
    fun fansOutToEveryCollectorAndFiltersByType() =
        runTest {
            enqueueEvents(
                stateChanged,
                """{"type":"local:changed","terminalId":"lt1","hostId":"h1"}""",
            )
            val hub = hub()
            turbineScope {
                val all = hub.events.testIn(backgroundScope)
                val typed = hub.on<TaskStateChangedEvent>().testIn(backgroundScope)
                val local = hub.unknown("local:changed").testIn(backgroundScope)
                hub.start()
                assertIs<TaskStateChangedEvent>(all.awaitItem())
                assertIs<WsEvent.Unknown>(all.awaitItem())
                assertEquals("t1", typed.awaitItem().taskId)
                assertEquals(JsonPrimitive("lt1"), local.awaitItem()["terminalId"])
                hub.stop()
                all.cancelAndIgnoreRemainingEvents()
                typed.cancelAndIgnoreRemainingEvents()
                local.cancelAndIgnoreRemainingEvents()
            }
        }

    @Test
    fun connectedFollowsTheSocketAndStopResetsIt() =
        runTest {
            enqueueEvents()
            val hub = hub()
            assertFalse(hub.isRunning)
            hub.start()
            assertTrue(hub.isRunning)
            awaitConnected(hub)
            hub.start() // already running: no second socket
            hub.stop()
            assertFalse(hub.connected.value)
            assertFalse(hub.isRunning)
            assertEquals(1, server.requestCount)

            enqueueEvents()
            hub.restart()
            awaitConnected(hub)
            assertEquals(2, server.requestCount)
            hub.stop()
        }

    /** Waits on the wall clock: runTest's own timeouts are virtual. */
    private suspend fun awaitConnected(hub: EventHub) =
        withContext(Dispatchers.Default) { withTimeout(5_000) { hub.connected.first { it } } }

    @Test
    fun anUnconfiguredClientNeverStarts() {
        val hub = EventHub(ApiClient())
        hub.start()
        assertFalse(hub.isRunning)
    }

    @Test
    fun decodeFallsBackToUnknown() {
        val raw = kotlinx.serialization.json.buildJsonObject { put("type", JsonPrimitive("future:thing")) }
        assertEquals(WsEvent.Unknown(raw), EventHub.decode(raw))
    }
}
