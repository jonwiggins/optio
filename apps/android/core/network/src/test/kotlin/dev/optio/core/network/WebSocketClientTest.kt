package dev.optio.core.network

import app.cash.turbine.ReceiveTurbine
import app.cash.turbine.test
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlin.test.AfterTest
import kotlin.test.BeforeTest
import kotlin.test.Test
import kotlin.test.assertContentEquals
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.concurrent.thread
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/** WebSocketClient against MockWebServer: subprotocol auth, frame kinds, sending, the reconnect policy. */
class WebSocketClientTest {
    private lateinit var server: MockWebServer

    @BeforeTest
    fun setUp() {
        server = MockWebServer()
        server.start()
    }

    @AfterTest
    fun tearDown() {
        server.close()
    }

    /** Server side of one upgrade: runs [onOpen] and records what the client sends. */
    private class ServerSocket(
        private val onOpen: (WebSocket) -> Unit = {},
    ) : WebSocketListener() {
        val received = LinkedBlockingQueue<Any>()

        override fun onOpen(
            webSocket: WebSocket,
            response: Response,
        ) = onOpen.invoke(webSocket)

        override fun onMessage(
            webSocket: WebSocket,
            text: String,
        ) {
            received.put(text)
        }

        override fun onMessage(
            webSocket: WebSocket,
            bytes: ByteString,
        ) {
            received.put(bytes)
        }

        override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            received.put("closing:$code")
            webSocket.close(1000, null)
        }
    }

    private fun enqueueSocket(listener: WebSocketListener) = server.enqueue(MockResponse.Builder().webSocketUpgrade(listener).build())

    private fun wsUrl(path: String = "/ws/test") = "ws://${server.hostName}:${server.port}$path"

    private fun client(
        token: String? = "tok",
        autoReconnect: Boolean = true,
    ) = WebSocketClient(
        url = wsUrl(),
        tokenProvider = { token },
        autoReconnect = autoReconnect,
        reconnectDelay = 100.milliseconds,
    )

    private fun takeRequest() = checkNotNull(server.takeRequest(5, TimeUnit.SECONDS)) { "no request" }

    @Test
    fun authRidesInTheSubprotocolHeader() =
        runTest {
            enqueueSocket(ServerSocket())
            val ws = client(token = "optio_pat_abc")
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                val request = takeRequest()
                assertEquals("optio-ws-v1, optio-auth-optio_pat_abc", request.headers["Sec-WebSocket-Protocol"])
                assertEquals("/ws/test", request.url.encodedPath)
                assertNull(request.url.query, "the token never goes in the URL")
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun withoutATokenOnlyTheProtocolIsOffered() =
        runTest {
            enqueueSocket(ServerSocket())
            val ws = client(token = null)
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertEquals("optio-ws-v1", takeRequest().headers["Sec-WebSocket-Protocol"])
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun theApiConstructorPrefersASingleUseWsToken() =
        runTest {
            val api = ApiClient(baseUrl = server.url("/").toString(), token = "optio_pat_pat")
            server.enqueue(MockResponse.Builder().body("""{"token":"minted123"}""").build())
            enqueueSocket(ServerSocket())
            val ws = api.webSocket("/ws/events")
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertEquals("/api/auth/ws-token", takeRequest().url.encodedPath)
                val upgrade = takeRequest()
                assertEquals("/ws/events", upgrade.url.encodedPath)
                assertEquals("optio-ws-v1, optio-auth-minted123", upgrade.headers["Sec-WebSocket-Protocol"])
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun theApiConstructorFallsBackToThePat() =
        runTest {
            val api = ApiClient(baseUrl = server.url("/").toString(), token = "optio_pat_pat")
            server.enqueue(MockResponse.Builder().code(500).body("""{"error":"boom"}""").build())
            enqueueSocket(ServerSocket())
            val ws = api.webSocket("/ws/events")
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                takeRequest()
                assertEquals("optio-ws-v1, optio-auth-optio_pat_pat", takeRequest().headers["Sec-WebSocket-Protocol"])
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun framesArriveAsJsonTextOrBinaryInOrder() =
        runTest {
            enqueueSocket(
                ServerSocket { socket ->
                    socket.send("""{"type":"task:log","content":"hi"}""")
                    socket.send("plain text")
                    socket.send("[1,2,3]")
                    socket.send(byteArrayOf(1, 2, 3).toByteString())
                },
            )
            val ws = client()
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                val json = assertIs<WsFrame.Json>(awaitItem())
                assertEquals("hi", json.value["content"]?.jsonPrimitive?.content)
                assertEquals(WsFrame.Text("plain text"), awaitItem())
                assertEquals(WsFrame.Text("[1,2,3]"), awaitItem(), "only JSON objects become Json frames")
                val binary = assertIs<WsFrame.Binary>(awaitItem())
                assertContentEquals(byteArrayOf(1, 2, 3), binary.bytes)
                assertTrue(ws.isOpen)
                ws.disconnect()
                assertFalse(ws.isOpen)
                awaitComplete()
            }
        }

    @Serializable
    private data class Resize(val type: String, val cols: Int, val rows: Int)

    @Test
    fun jsonFramesDecodeAndTheClientSendsTextJsonAndBinary() =
        runTest {
            val server = ServerSocket { it.send("""{"type":"resize","cols":80,"rows":24}""") }
            enqueueSocket(server)
            val ws = client()
            assertFalse(ws.send("too early"), "nothing is sent before the socket opens")
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertEquals(Resize("resize", 80, 24), assertIs<WsFrame.Json>(awaitItem()).decode<Resize>())
                assertTrue(ws.send("hello"))
                assertTrue(ws.send(buildJsonObject { put("type", "ping") }))
                assertTrue(ws.sendJson(Resize("resize", 100, 30)))
                assertTrue(ws.send(byteArrayOf(9, 8)))
                assertEquals("hello", server.received.poll(5, TimeUnit.SECONDS))
                assertEquals("""{"type":"ping"}""", server.received.poll(5, TimeUnit.SECONDS))
                assertEquals("""{"type":"resize","cols":100,"rows":30}""", server.received.poll(5, TimeUnit.SECONDS))
                assertEquals(byteArrayOf(9, 8).toByteString(), server.received.poll(5, TimeUnit.SECONDS))
                ws.disconnect()
                assertEquals("closing:1000", server.received.poll(5, TimeUnit.SECONDS), "disconnect closes with 1000")
                awaitComplete()
            }
        }

    @Test
    fun reconnectsAfterATransientClose() =
        runTest {
            enqueueSocket(ServerSocket { it.close(4503, "Host disconnected") })
            enqueueSocket(ServerSocket { it.send("""{"n":2}""") })
            val ws = client()
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertEquals(WsFrame.Closed(4503, "Host disconnected"), awaitItem())
                assertEquals(WsFrame.Opened, awaitItem(), "reconnected after the delay")
                assertIs<WsFrame.Json>(awaitItem())
                assertEquals(2, server.requestCount)
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun permanentCloseCodesNeverReconnect() =
        runTest {
            for (code in listOf(4401, 4403, 4404, 4429)) {
                enqueueSocket(ServerSocket { it.close(code, "no") })
                val before = server.requestCount
                val ws = client()
                ws.connect()
                ws.frames.test {
                    assertEquals(WsFrame.Opened, awaitItem())
                    assertEquals(WsFrame.Closed(code, "no"), awaitItem())
                    expectNoFramesFor(400)
                    assertEquals(before + 1, server.requestCount, "no reconnect after $code")
                    ws.disconnect()
                    awaitComplete()
                }
            }
        }

    @Test
    fun withoutAutoReconnectAClosedClientStaysClosedUntilConnectIsCalled() =
        runTest {
            enqueueSocket(ServerSocket { it.close(1001, "going away") })
            enqueueSocket(ServerSocket())
            val ws = client(autoReconnect = false)
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertEquals(WsFrame.Closed(1001, "going away"), awaitItem())
                expectNoFramesFor(400)
                ws.connect()
                assertEquals(WsFrame.Opened, awaitItem(), "a manual connect opens a new connection")
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun aDroppedConnectionIsClosed1006AndRetried() =
        runTest {
            server.enqueue(MockResponse.Builder().code(502).body("bad gateway").build())
            enqueueSocket(ServerSocket())
            val ws = client()
            ws.connect()
            ws.frames.test {
                val closed = assertIs<WsFrame.Closed>(awaitItem())
                assertEquals(1006, closed.code)
                assertEquals("HTTP 502", closed.reason)
                assertEquals(WsFrame.Opened, awaitItem())
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun disconnectEndsTheFramesWithoutAClosedFrameAndIsFinal() =
        runTest {
            enqueueSocket(ServerSocket())
            val ws = client()
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                ws.disconnect()
                awaitComplete()
            }
            ws.connect()
            realDelay(200)
            assertEquals(1, server.requestCount, "a disconnected client never connects again")
        }

    /** Server side that timestamps what arrives and, optionally, speaks first after a delay. */
    private class TimedServerSocket(
        private val firstFrameAfterMillis: Long?,
    ) : WebSocketListener() {
        val received = LinkedBlockingQueue<Pair<Any, Long>>()

        @Volatile
        var firstFrameSentAt = 0L

        override fun onOpen(
            webSocket: WebSocket,
            response: Response,
        ) {
            val delayMillis = firstFrameAfterMillis ?: return
            // Like an auth-enabled server: busy validating the token for a moment, then speaks.
            thread {
                Thread.sleep(delayMillis)
                firstFrameSentAt = System.nanoTime()
                webSocket.send("""{"type":"ready"}""")
            }
        }

        override fun onMessage(
            webSocket: WebSocket,
            text: String,
        ) {
            received.put(text to System.nanoTime())
        }

        override fun onMessage(
            webSocket: WebSocket,
            bytes: ByteString,
        ) {
            received.put(bytes to System.nanoTime())
        }

        override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            webSocket.close(1000, null)
        }

        fun next(): Pair<Any, Long> = checkNotNull(received.poll(5, TimeUnit.SECONDS)) { "nothing arrived" }
    }

    @Test
    fun sendsRightAfterOpenWaitForTheServersFirstFrameAndKeepTheirOrder() =
        runTest {
            val server = TimedServerSocket(firstFrameAfterMillis = 200)
            enqueueSocket(server)
            // A long hold: only the server's first frame can let these through in time.
            val ws = WebSocketClient(url = wsUrl(), tokenProvider = { "tok" }, sendHold = 3.seconds)
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                assertTrue(ws.send("first"))
                assertTrue(ws.send(byteArrayOf(7)))
                assertTrue(ws.sendJson(Resize("resize", 80, 24)))

                val first = server.next()
                assertEquals("first", first.first)
                assertTrue(first.second >= server.firstFrameSentAt, "held until the server spoke")
                assertEquals(byteArrayOf(7).toByteString(), server.next().first)
                assertEquals("""{"type":"resize","cols":80,"rows":24}""", server.next().first)
                assertIs<WsFrame.Json>(awaitItem())

                // Once the server has spoken, sends go straight out.
                val sentAt = System.nanoTime()
                assertTrue(ws.send("later"))
                val later = server.next()
                assertEquals("later", later.first)
                assertTrue(later.second - sentAt < 1_000_000_000L)
                ws.disconnect()
                awaitComplete()
            }
        }

    @Test
    fun heldSendsGoAfterTheHoldWhenTheServerStaysQuiet() =
        runTest {
            val server = TimedServerSocket(firstFrameAfterMillis = null)
            enqueueSocket(server)
            val ws = WebSocketClient(url = wsUrl(), tokenProvider = { "tok" }, sendHold = 300.milliseconds)
            ws.connect()
            ws.frames.test {
                assertEquals(WsFrame.Opened, awaitItem())
                val sentAt = System.nanoTime()
                assertTrue(ws.send("hello"))
                val (message, arrivedAt) = server.next()
                assertEquals("hello", message)
                assertTrue(arrivedAt - sentAt >= 250_000_000L, "held for the hold period: ${(arrivedAt - sentAt) / 1_000_000} ms")
                ws.disconnect()
                awaitComplete()
            }
        }

    private suspend fun ReceiveTurbine<WsFrame>.expectNoFramesFor(millis: Long) {
        realDelay(millis)
        expectNoEvents()
    }

    /** Waits on the wall clock (runTest's own delay is virtual and would not let the socket act). */
    private suspend fun realDelay(millis: Long) = withContext(Dispatchers.IO) { delay(millis) }
}
