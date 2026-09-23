package dev.optio.core.testing

import dev.optio.core.model.OptioJson
import dev.optio.core.network.ApiClient
import java.io.Closeable
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.LinkedBlockingQueue
import java.util.concurrent.TimeUnit
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import mockwebserver3.Dispatcher
import mockwebserver3.MockResponse
import mockwebserver3.MockWebServer
import mockwebserver3.RecordedRequest
import okhttp3.Headers
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import org.junit.rules.ExternalResource

/**
 * A fake Optio API on MockWebServer for JVM / Robolectric tests: routes `METHOD path` to fixtures
 * or handlers, records every request, and serves WebSockets.
 *
 * ```
 * val server = FakeOptioServer().start()          // or @get:Rule val rule = FakeOptioServerRule()
 * server.fixture("/api/tasks/:id", "task.json")   // GET by default; `:id` matches one segment
 * server.post("/api/tasks/:id/retry") { req -> FakeResponse.json("""{"ok":true}""") }
 * server.error("GET", "/api/workspaces", 401, "Unauthorized")
 * val api = server.client()                       // an ApiClient pointed here
 * …
 * server.lastRequest("POST", "/api/tasks/t1/retry")!!.header("Authorization")
 * server.close()
 * ```
 *
 * Routes: the newest registration that matches wins (override a default in one test). Paths match
 * without the query; `:name` matches one segment (read it from [FakeRequest.pathParams]) and a
 * trailing `*` any rest. Unmatched requests answer 404 `{"error":"No route for GET /x"}`.
 * Fixtures resolve through [Fixtures] (the calling module's `src/test/resources/fixtures/`, then the
 * shared ones shipped in `:core:testing`).
 */
class FakeOptioServer : Closeable {
    private val server = MockWebServer()
    private val routes = CopyOnWriteArrayList<Route>()
    private val recorded = CopyOnWriteArrayList<FakeRequest>()
    private val arrivals = LinkedBlockingQueue<FakeRequest>()

    /** Starts listening on a free localhost port. */
    fun start(): FakeOptioServer {
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = handle(request)
        }
        server.start()
        return this
    }

    /** `http://127.0.0.1:<port>` (no trailing slash): the base URL for an [ApiClient]. */
    val baseUrl: String
        get() = server.url("/").toString().removeSuffix("/")

    /** The absolute URL of [path]. */
    fun url(path: String): String = baseUrl + path

    /** The `ws://` URL of [path]. */
    fun wsUrl(path: String): String = "ws" + url(path).removePrefix("http")

    /** An [ApiClient] pointed at this server with [token] (auth is not checked unless a route does). */
    fun client(token: String = TEST_TOKEN, workspaceId: String? = null): ApiClient = ApiClient(baseUrl, token, workspaceId)

    // region Routes

    /** Routes `METHOD path` (`*` for any method) to [handler]. */
    fun on(method: String, path: String, handler: (FakeRequest) -> FakeResponse): FakeOptioServer {
        routes += Route(method.uppercase(), PathPattern(path), handler)
        return this
    }

    fun get(path: String, handler: (FakeRequest) -> FakeResponse) = on("GET", path, handler)

    fun post(path: String, handler: (FakeRequest) -> FakeResponse) = on("POST", path, handler)

    fun patch(path: String, handler: (FakeRequest) -> FakeResponse) = on("PATCH", path, handler)

    fun put(path: String, handler: (FakeRequest) -> FakeResponse) = on("PUT", path, handler)

    fun delete(path: String, handler: (FakeRequest) -> FakeResponse) = on("DELETE", path, handler)

    /** Answers [path] with a literal JSON [body]. */
    fun json(path: String, body: String, method: String = "GET", status: Int = 200) =
        on(method, path) { FakeResponse.json(body, status) }

    /** Answers [path] with the fixture file [name] ([Fixtures.text]). */
    fun fixture(path: String, name: String, method: String = "GET", status: Int = 200) =
        on(method, path) { FakeResponse.fixture(name, status) }

    /** Answers [path] with an API error (`{"error": message}`), as the server does. */
    fun error(method: String, path: String, status: Int, message: String = "Error") =
        on(method, path) { FakeResponse.error(status, message) }

    /** Serves a WebSocket at [path]; each connection becomes a [FakeSocket] on the endpoint. */
    fun webSocket(path: String, protocol: String? = "optio-ws-v1"): FakeSocketEndpoint {
        val endpoint = FakeSocketEndpoint(path, protocol)
        routes += Route("GET", PathPattern(path), handler = null, socket = endpoint)
        return endpoint
    }

    /** Drops every route. */
    fun resetRoutes() {
        routes.clear()
    }

    // endregion

    // region Recording

    /** Every request received so far, oldest first. */
    val requests: List<FakeRequest>
        get() = recorded.toList()

    /** Requests matching [method] (any when null) and [path] (exact path or a pattern). */
    fun requests(method: String? = null, path: String? = null): List<FakeRequest> {
        val pattern = path?.let(::PathPattern)
        return recorded.filter { r ->
            (method == null || r.method.equals(method, ignoreCase = true)) && (pattern == null || pattern.match(r.path) != null)
        }
    }

    /** The newest request matching [method] and [path], or null. */
    fun lastRequest(method: String? = null, path: String? = null): FakeRequest? = requests(method, path).lastOrNull()

    /** How many requests matched [method] and [path]. */
    fun count(method: String? = null, path: String? = null): Int = requests(method, path).size

    /**
     * Blocks until a request matching [method] and [path] arrives (or has arrived since the last
     * await), up to [timeoutMs]. Throws [AssertionError] on timeout.
     */
    fun awaitRequest(method: String? = null, path: String? = null, timeoutMs: Long = 5_000): FakeRequest {
        val pattern = path?.let(::PathPattern)
        val deadline = System.nanoTime() + TimeUnit.MILLISECONDS.toNanos(timeoutMs)
        while (true) {
            val remaining = deadline - System.nanoTime()
            if (remaining <= 0) throw AssertionError("No ${method ?: "*"} ${path ?: "*"} within ${timeoutMs}ms; got ${requests.map { "${it.method} ${it.path}" }}")
            val next = arrivals.poll(remaining, TimeUnit.NANOSECONDS) ?: continue
            if ((method == null || next.method.equals(method, ignoreCase = true)) && (pattern == null || pattern.match(next.path) != null)) return next
        }
    }

    /** Forgets recorded requests. */
    fun clearRequests() {
        recorded.clear()
        arrivals.clear()
    }

    // endregion

    override fun close() {
        server.close()
    }

    private fun handle(request: RecordedRequest): MockResponse {
        val url = request.url
        val path = url.encodedPath
        val method = request.method.uppercase()
        val route = routes.asReversed().firstOrNull { (it.method == "*" || it.method == method) && it.pattern.match(path) != null }
        val fake = FakeRequest(
            method = method,
            path = path,
            query = url.queryParameterNames.associateWith { url.queryParameterValues(it).filterNotNull() },
            headers = request.headers,
            body = request.body?.utf8() ?: "",
            pathParams = route?.pattern?.match(path).orEmpty(),
        )
        recorded += fake
        arrivals += fake
        route?.socket?.let { endpoint -> return endpoint.upgrade(fake) }
        val response = try {
            route?.handler?.invoke(fake) ?: FakeResponse.error(404, "No route for $method $path")
        } catch (e: Throwable) {
            FakeResponse.error(500, "Handler failed: ${e.message}")
        }
        return response.toMockResponse()
    }

    private class Route(
        val method: String,
        val pattern: PathPattern,
        val handler: ((FakeRequest) -> FakeResponse)?,
        val socket: FakeSocketEndpoint? = null,
    )

    companion object {
        /** The token [client] sends by default. */
        const val TEST_TOKEN = "optio_pat_test"
    }
}

/** `/api/tasks/:id/logs`, `/api/local/<star>`: `:name` = one segment, a trailing star = the rest. */
internal class PathPattern(pattern: String) {
    private val parts = pattern.substringBefore('?').trim('/').split('/').filter { it.isNotEmpty() }

    /** The path parameters when [path] matches, else null. */
    fun match(path: String): Map<String, String>? {
        val segments = path.trim('/').split('/').filter { it.isNotEmpty() }
        val params = mutableMapOf<String, String>()
        parts.forEachIndexed { index, part ->
            if (part == "*" && index == parts.lastIndex) return params
            val segment = segments.getOrNull(index) ?: return null
            when {
                part.startsWith(':') -> params[part.drop(1)] = segment
                part != segment -> return null
            }
        }
        return if (segments.size == parts.size) params else null
    }
}

/** A request the fake server received. */
data class FakeRequest(
    val method: String,
    /** The encoded path, without the query. */
    val path: String,
    val query: Map<String, List<String>>,
    val headers: Headers,
    /** The body as UTF-8 ("" when none). */
    val body: String,
    /** Values of the route's `:name` segments. */
    val pathParams: Map<String, String>,
) {
    /** The first value of query parameter [name]. */
    fun queryParam(name: String): String? = query[name]?.firstOrNull()

    fun header(name: String): String? = headers[name]

    /** The body parsed as JSON (JsonNull when empty). */
    val json: JsonElement
        get() = if (body.isBlank()) kotlinx.serialization.json.JsonNull else OptioJson.parseToJsonElement(body)

    /** The body decoded as [T] with `OptioJson`. */
    inline fun <reified T> bodyAs(): T = OptioJson.decodeFromString(body)
}

/** What a route answers. */
class FakeResponse(
    val status: Int = 200,
    val body: String = "",
    val headers: Map<String, String> = mapOf("Content-Type" to "application/json"),
    /** Delay before the headers go out (loading states, timeouts). */
    val delayMs: Long = 0,
) {
    internal fun toMockResponse(): MockResponse {
        val builder = MockResponse.Builder().code(status).body(body)
        headers.forEach { (name, value) -> builder.setHeader(name, value) }
        if (delayMs > 0) builder.headersDelay(delayMs, TimeUnit.MILLISECONDS)
        return builder.build()
    }

    /** The same response after [ms] milliseconds. */
    fun delayed(ms: Long): FakeResponse = FakeResponse(status, body, headers, ms)

    companion object {
        fun json(body: String, status: Int = 200) = FakeResponse(status, body)

        /** [value] encoded with `OptioJson`. */
        inline fun <reified T> of(value: T, status: Int = 200) = json(OptioJson.encodeToString(value), status)

        /** A fixture file's contents. */
        fun fixture(name: String, status: Int = 200) = json(Fixtures.text(name), status)

        /** The server's error envelope `{"error": message}`. */
        fun error(status: Int, message: String) =
            json(JsonObject(mapOf("error" to JsonPrimitive(message))).toString(), status)

        /** No content. */
        fun empty(status: Int = 204) = FakeResponse(status, "", emptyMap())
    }
}

/**
 * A WebSocket route on [FakeOptioServer]. Every upgrade becomes a [FakeSocket] in [connections];
 * [awaitConnection] blocks for the next one. [protocol] is echoed as `Sec-WebSocket-Protocol`.
 */
class FakeSocketEndpoint internal constructor(val path: String, private val protocol: String?) {
    private val all = CopyOnWriteArrayList<FakeSocket>()
    private val opened = LinkedBlockingQueue<FakeSocket>()

    /** Every connection so far, oldest first. */
    val connections: List<FakeSocket>
        get() = all.toList()

    /** Blocks until a client connects (or one connected since the last await). */
    fun awaitConnection(timeoutMs: Long = 5_000): FakeSocket =
        opened.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: throw AssertionError("No WebSocket connection to $path within ${timeoutMs}ms")

    internal fun upgrade(request: FakeRequest): MockResponse {
        val socket = FakeSocket(request) { opened += it }
        all += socket
        val builder = MockResponse.Builder().webSocketUpgrade(socket)
        if (protocol != null) builder.setHeader("Sec-WebSocket-Protocol", protocol)
        return builder.build()
    }
}

/** The server side of one WebSocket connection: what the client sent, and a way to talk back. */
class FakeSocket internal constructor(
    /** The upgrade request (headers carry `Sec-WebSocket-Protocol` with the auth token). */
    val request: FakeRequest,
    private val onOpened: (FakeSocket) -> Unit,
) : WebSocketListener() {
    @Volatile
    private var socket: WebSocket? = null
    private val texts = LinkedBlockingQueue<String>()
    private val allTexts = CopyOnWriteArrayList<String>()
    private val allBytes = CopyOnWriteArrayList<ByteString>()

    /** Text frames received from the client, oldest first. */
    val received: List<String>
        get() = allTexts.toList()

    /** Binary frames received from the client. */
    val receivedBytes: List<ByteString>
        get() = allBytes.toList()

    /** Set once the client closed (or the connection failed): (code, reason). */
    @Volatile
    var closed: Pair<Int, String>? = null
        private set

    fun sendText(text: String): Boolean = checkNotNull(socket) { "socket not open" }.send(text)

    /** Sends [value] encoded with `OptioJson` as a text frame. */
    inline fun <reified T> sendJson(value: T): Boolean = sendText(OptioJson.encodeToString(value))

    fun sendBytes(bytes: ByteString): Boolean = checkNotNull(socket) { "socket not open" }.send(bytes)

    /** Closes from the server side ([code] e.g. 4401 to test the client's no-reconnect codes). */
    fun close(code: Int = 1000, reason: String = ""): Boolean = checkNotNull(socket) { "socket not open" }.close(code, reason)

    /** Blocks for the next text frame from the client. */
    fun awaitText(timeoutMs: Long = 5_000): String =
        texts.poll(timeoutMs, TimeUnit.MILLISECONDS) ?: throw AssertionError("No text frame within ${timeoutMs}ms")

    override fun onOpen(webSocket: WebSocket, response: Response) {
        socket = webSocket
        onOpened(this)
    }

    override fun onMessage(webSocket: WebSocket, text: String) {
        allTexts += text
        texts += text
    }

    override fun onMessage(webSocket: WebSocket, bytes: ByteString) {
        allBytes += bytes
    }

    override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
        closed = code to reason
        webSocket.close(code, reason)
    }

    override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
        if (closed == null) closed = -1 to (t.message ?: "failure")
    }
}

/** JUnit rule owning a [FakeOptioServer]: started before each test, closed after. */
class FakeOptioServerRule : ExternalResource() {
    val server = FakeOptioServer()

    override fun before() {
        server.start()
    }

    override fun after() {
        server.close()
    }
}
