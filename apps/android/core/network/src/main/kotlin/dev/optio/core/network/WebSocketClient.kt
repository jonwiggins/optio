package dev.optio.core.network

import kotlin.time.Duration
import kotlin.time.Duration.Companion.milliseconds
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.toByteString

/**
 * WebSocket client over OkHttp (port of iOS `WebSocketClient`, mirroring
 * `apps/web/src/lib/ws-client.ts`).
 *
 * - Auth rides in `Sec-WebSocket-Protocol: optio-ws-v1, optio-auth-<token>`; the server picks
 *   `optio-ws-v1`, so the token is never echoed and never appears in a URL. [tokenProvider] runs
 *   before every (re)connect; the [ApiClient] constructor prefers a single-use
 *   `GET /api/auth/ws-token` and falls back to the PAT.
 * - [frames] delivers [WsFrame]s in order to ONE collector (a buffered channel, like iOS's
 *   `AsyncStream`): nothing is lost between [connect] and the first `collect`.
 * - After a close it reconnects in 3 s ([reconnectDelay]) unless [autoReconnect] is off, the
 *   client was [disconnect]ed, or the close code is permanent (4401 unauthorized, 4403 forbidden,
 *   4404 not found, 4429 connection limit).
 * - [disconnect] closes with 1000, emits no [WsFrame.Closed], and completes [frames]; the client
 *   is spent afterwards (create a new one to connect again). Without auto-reconnect, calling
 *   [connect] again after a [WsFrame.Closed] opens a new connection on the same client.
 * - Sends right after [WsFrame.Opened] are held until the server's first frame arrives, or for
 *   [sendHold] (300 ms), whichever comes first, then flushed in order. An auth-enabled server
 *   attaches its message listener only after validating the token, so anything sent before then is
 *   silently dropped; every Optio stream speaks first (catch-up, `status`, `ready`, history), so
 *   the hold costs nothing. Sends while no connection is open return false.
 *
 * ```
 * val ws = api.webSocket("/ws/logs/$taskId")
 * ws.connect()
 * viewModelScope.launch {
 *     ws.frames.collect { frame ->
 *         when (frame) {
 *             is WsFrame.Json -> handle(frame.decode<TaskLogEvent>())
 *             is WsFrame.Closed -> …
 *             else -> Unit
 *         }
 *     }
 * }
 * // onCleared: ws.disconnect()
 * ```
 */
class WebSocketClient(
    /**
     * Resolves the `ws(s)://…` URL ([ApiClient.wsUrl]) on each connect. Resolving late means a
     * socket made for a client that has no server (a screen outliving sign-out or a server
     * switch) reports [CloseCode.NO_SERVER] instead of throwing from a constructor.
     */
    private val urlProvider: () -> String,
    private val tokenProvider: suspend () -> String?,
    private val autoReconnect: Boolean = true,
    private val httpClient: OkHttpClient = OptioHttp.webSocketClient,
    private val reconnectDelay: Duration = RECONNECT_DELAY,
    dispatcher: CoroutineDispatcher = Dispatchers.IO,
    private val sendHold: Duration = SEND_HOLD,
) {
    /** A socket for a fixed `ws(s)://…` [url]. */
    constructor(
        url: String,
        tokenProvider: suspend () -> String?,
        autoReconnect: Boolean = true,
        httpClient: OkHttpClient = OptioHttp.webSocketClient,
        reconnectDelay: Duration = RECONNECT_DELAY,
        dispatcher: CoroutineDispatcher = Dispatchers.IO,
        sendHold: Duration = SEND_HOLD,
    ) : this({ url }, tokenProvider, autoReconnect, httpClient, reconnectDelay, dispatcher, sendHold)

    /** [path] on [api]'s server, authenticated with a fresh ws-token (else [api]'s PAT). */
    constructor(api: ApiClient, path: String, autoReconnect: Boolean = true) : this(
        urlProvider = { api.wsUrl(path) },
        tokenProvider = api.webSocketTokenProvider(),
        autoReconnect = autoReconnect,
        httpClient = api.webSocketHttpClient,
    )

    /** `ws(s)://…` URL of the socket; throws [ApiError] when its client has no server. */
    val url: String
        get() = urlProvider()

    /** Close codes the server uses (`apps/api/src/ws/ws-auth.ts`, `ws-authz.ts`, `ws-limits.ts`). */
    object CloseCode {
        const val NORMAL = 1000
        const val ABNORMAL = 1006
        const val UNAUTHORIZED = 4401
        const val FORBIDDEN = 4403
        const val NOT_FOUND = 4404
        const val HELLO_TIMEOUT = 4408
        const val MESSAGE_TOO_LARGE = 4413
        const val CONNECTION_LIMIT = 4429

        /** Client-side: the socket's [ApiClient] has no server configured (never sent by the API). */
        const val NO_SERVER = 4000

        /** Codes no retry can fix: the client never reconnects after them. */
        val permanent: Set<Int> = setOf(UNAUTHORIZED, FORBIDDEN, NOT_FOUND, CONNECTION_LIMIT, NO_SERVER)
    }

    private val scope = CoroutineScope(SupervisorJob() + dispatcher)
    private val channel = Channel<WsFrame>(Channel.UNLIMITED)
    private val lock = Any()

    // Guarded by [lock].
    private var socket: WebSocket? = null
    private var opened = false
    private var connectJob: Job? = null
    private var closed = false
    private var finished = false

    // The send gate of the open connection (see the class doc). Guarded by [lock].
    private var gateOpen = false
    private val held = ArrayList<Any>()
    private var gateJob: Job? = null

    /** Every frame, in order, for one collector. Completes after [disconnect]. */
    val frames: Flow<WsFrame> = channel.receiveAsFlow()

    /** True while a connection is open (between [WsFrame.Opened] and [WsFrame.Closed]). */
    val isOpen: Boolean
        get() = synchronized(lock) { opened }

    /** Opens the connection (no-op while one is open or being opened, or after [disconnect]). */
    fun connect() {
        synchronized(lock) {
            if (finished) return
            closed = false
            if (socket != null || connectJob?.isActive == true) return
            connectJob = scope.launch { open() }
        }
    }

    /** Closes the connection for good: no [WsFrame.Closed] follows, [frames] completes. */
    fun disconnect() {
        synchronized(lock) {
            if (finished) return
            finished = true
            closed = true
            connectJob?.cancel()
            connectJob = null
            closeGate()
            socket?.close(CloseCode.NORMAL, null)
            socket = null
            opened = false
            channel.close()
        }
        scope.cancel()
    }

    /** Sends a text frame (held until the server has spoken, see above); false when not connected. */
    fun send(text: String): Boolean = enqueue(text)

    /** Sends [json] as a text frame; false when not connected. */
    fun send(json: JsonElement): Boolean = send(json.toString())

    /** Sends a binary frame; false when not connected. */
    fun send(bytes: ByteArray): Boolean = enqueue(bytes.toByteString())

    /** Sends a binary frame; false when not connected. */
    fun send(bytes: ByteString): Boolean = enqueue(bytes)

    /** Sends [value] encoded with the Optio JSON rules as a text frame; false when not connected. */
    inline fun <reified T> sendJson(value: T): Boolean = send(dev.optio.core.model.OptioJson.encodeToString(value))

    /** Transmits [message] now, or holds it while the gate is shut. */
    private fun enqueue(message: Any): Boolean =
        synchronized(lock) {
            val ws = socket?.takeIf { opened } ?: return false
            if (!gateOpen) {
                held += message
                true
            } else {
                transmit(ws, message)
            }
        }

    private fun transmit(
        ws: WebSocket,
        message: Any,
    ): Boolean =
        when (message) {
            is String -> ws.send(message)
            is ByteString -> ws.send(message)
            else -> false
        }

    /** Lets [ws]'s held sends through, in order. Call under [lock]. */
    private fun openGate(ws: WebSocket) {
        if (ws !== socket || gateOpen) return
        gateOpen = true
        gateJob?.cancel()
        gateJob = null
        held.forEach { transmit(ws, it) }
        held.clear()
    }

    /** Forgets the connection's gate and anything it held. Call under [lock]. */
    private fun closeGate() {
        gateJob?.cancel()
        gateJob = null
        gateOpen = false
        held.clear()
    }

    private suspend fun open() {
        val token =
            try {
                tokenProvider()
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                null
            }
        val target =
            try {
                urlProvider()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                synchronized(lock) { if (!closed) emit(WsFrame.Closed(CloseCode.NO_SERVER, e.message)) }
                return
            }
        val protocols = listOfNotNull(PROTOCOL, token?.let { AUTH_PROTOCOL_PREFIX + it }).joinToString(", ")
        val request =
            Request.Builder()
                .url(target)
                .header("Sec-WebSocket-Protocol", protocols)
                .build()
        synchronized(lock) {
            if (closed || socket != null) return
            socket = httpClient.newWebSocket(request, Listener())
        }
    }

    private fun emit(frame: WsFrame) {
        channel.trySend(frame)
    }

    private fun handleClosed(
        webSocket: WebSocket,
        code: Int,
        reason: String?,
    ) {
        synchronized(lock) {
            if (webSocket !== socket) return
            socket = null
            opened = false
            closeGate()
            emit(WsFrame.Closed(code, reason?.takeIf { it.isNotEmpty() }))
            if (closed || !autoReconnect || code in CloseCode.permanent) return
            connectJob =
                scope.launch {
                    delay(reconnectDelay)
                    open()
                }
        }
    }

    private inner class Listener : WebSocketListener() {
        override fun onOpen(
            webSocket: WebSocket,
            response: Response,
        ) {
            synchronized(lock) {
                if (webSocket !== socket) return
                opened = true
                closeGate()
                gateJob =
                    scope.launch {
                        delay(sendHold)
                        synchronized(lock) { openGate(webSocket) }
                    }
                emit(WsFrame.Opened)
            }
        }

        override fun onMessage(
            webSocket: WebSocket,
            text: String,
        ) {
            val frame = textFrame(text)
            synchronized(lock) {
                if (webSocket !== socket) return
                openGate(webSocket)
                emit(frame)
            }
        }

        override fun onMessage(
            webSocket: WebSocket,
            bytes: ByteString,
        ) {
            synchronized(lock) {
                if (webSocket !== socket) return
                openGate(webSocket)
                emit(WsFrame.Binary(bytes.toByteArray()))
            }
        }

        override fun onClosing(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) {
            // Complete the close handshake (reserved codes like 1005 can't be echoed, so reply 1000).
            webSocket.close(CloseCode.NORMAL, null)
            handleClosed(webSocket, code, reason)
        }

        override fun onClosed(
            webSocket: WebSocket,
            code: Int,
            reason: String,
        ) = handleClosed(webSocket, code, reason)

        override fun onFailure(
            webSocket: WebSocket,
            t: Throwable,
            response: Response?,
        ) = handleClosed(webSocket, CloseCode.ABNORMAL, response?.let { "HTTP ${it.code}" } ?: t.message)
    }

    companion object {
        /** The subprotocol the server negotiates. */
        const val PROTOCOL = "optio-ws-v1"

        /** Prefix of the subprotocol entry carrying the token. */
        const val AUTH_PROTOCOL_PREFIX = "optio-auth-"

        /** Delay before an automatic reconnect (web and iOS: 3 s). */
        val RECONNECT_DELAY: Duration = 3.seconds

        /** How long sends wait after open for the server's first frame before they go anyway. */
        val SEND_HOLD: Duration = 300.milliseconds

        private val strictJson = Json

        /** A text frame as [WsFrame.Json] when it parses as a JSON object, else [WsFrame.Text]. */
        internal fun textFrame(text: String): WsFrame {
            val parsed = runCatching { strictJson.parseToJsonElement(text) }.getOrNull()
            return if (parsed is JsonObject) WsFrame.Json(parsed) else WsFrame.Text(text)
        }
    }
}

/** iOS's token provider: a single-use ws-token when the server mints one, else the PAT. */
internal fun ApiClient.webSocketTokenProvider(): suspend () -> String? =
    {
        try {
            wsToken()
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            token
        }
    }
