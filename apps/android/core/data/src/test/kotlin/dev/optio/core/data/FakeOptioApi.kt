package dev.optio.core.data

import java.io.Closeable
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.CopyOnWriteArrayList
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.WebSocket
import okhttp3.WebSocketListener

/**
 * One fake Optio server: `/api/auth/me` answers for [validTokens] (401 otherwise), `/api/auth/ws-token`
 * mints a token, `/ws/events` upgrades, and [routes] add anything else by path.
 */
internal class FakeOptioApi(
    private val email: String = "dev@localhost",
    private val role: String = "member",
) : Closeable {
    private val server = MockWebServer()

    @Volatile
    var validTokens: Set<String> = setOf(GOOD)

    /** Extra responses by path (e.g. `/api/workspaces` → 401). */
    val routes = ConcurrentHashMap<String, (RecordedRequest) -> MockResponse>()

    /** Every request, in order. */
    val requests = CopyOnWriteArrayList<RecordedRequest>()

    val url: String
        get() = server.url("/").toString().removeSuffix("/")

    init {
        server.dispatcher =
            object : Dispatcher() {
                override fun dispatch(request: RecordedRequest): MockResponse {
                    requests += request
                    val token = request.headers["Authorization"]?.removePrefix("Bearer ")
                    val path = request.url.encodedPath
                    routes[path]?.let { return it(request) }
                    return when (path) {
                        "/api/auth/me" ->
                            if (token in validTokens) {
                                val workspace = request.headers["x-workspace-id"]?.let { "\"$it\"" } ?: "null"
                                json("""{"user":{"id":"u1","email":"$email","displayName":"Dev","workspaceId":$workspace,"workspaceRole":"$role"},"authDisabled":false}""")
                            } else {
                                json("""{"error":"Invalid or expired session"}""", 401)
                            }
                        "/api/auth/ws-token" -> json("""{"token":"ws-token"}""")
                        "/ws/events" -> MockResponse.Builder().webSocketUpgrade(EventsSocket).build()
                        else -> json("""{"error":"Route not found"}""", 404)
                    }
                }
            }
        server.start()
    }

    fun meRequests(): Int = requests.count { it.url.encodedPath == "/api/auth/me" }

    override fun close() = server.close()

    private object EventsSocket : WebSocketListener() {
        override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            webSocket.close(1000, null)
        }
    }

    companion object {
        const val GOOD = "optio_pat_good"

        /** Nothing listens here: connecting fails at once. */
        const val UNREACHABLE = "http://127.0.0.1:1"

        fun json(
            body: String,
            code: Int = 200,
        ): MockResponse = MockResponse.Builder().code(code).setHeader("Content-Type", "application/json").body(body).build()
    }
}
