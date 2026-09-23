package dev.optio.core.network

import dev.optio.core.model.OptioJson
import dev.optio.core.model.WsEvent
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.flow.filterIsInstance
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.launch
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonObject

/**
 * The app's one `/ws/events` socket, fanned out to any number of collectors (port of iOS
 * `EventHub`): the Watch notification, widget refreshes, lists that refresh on change.
 *
 * Every JSON frame is decoded as the generated [WsEvent] union, one frame at a time: types this
 * app does not know (`local:changed`, newer server events) and frames that fail to decode arrive
 * as [WsEvent.Unknown] with the raw JSON, so nothing is dropped silently and one bad frame never
 * ends the stream.
 *
 * `SessionStore` owns the instance and starts it while signed in (restarting it on every server
 * switch). Collect [events] for as long as you need them:
 *
 * ```
 * LaunchedEffect(hub) {
 *     hub.on<TaskStateChangedEvent>().collect { refresh() }
 * }
 * ```
 */
class EventHub(
    private val api: ApiClient,
    private val socketFactory: (ApiClient) -> WebSocketClient = { WebSocketClient(it, PATH) },
    private val dispatcher: CoroutineDispatcher = Dispatchers.Default,
) {
    private val lock = Any()
    private var socket: WebSocketClient? = null
    private var scope: CoroutineScope? = null

    private val _events =
        MutableSharedFlow<WsEvent>(extraBufferCapacity = EVENT_BUFFER, onBufferOverflow = BufferOverflow.DROP_OLDEST)

    /** Every event from `/ws/events` while running. Hot: collectors only see events after they subscribe. */
    val events: SharedFlow<WsEvent> = _events.asSharedFlow()

    private val _connected = MutableStateFlow(false)

    /** True while the socket is open (false while stopped, connecting or reconnecting). */
    val connected: StateFlow<Boolean> = _connected.asStateFlow()

    /** True between [start] and [stop]. */
    val isRunning: Boolean
        get() = synchronized(lock) { socket != null }

    /** Opens the socket (no-op when running or when the client has no server). */
    fun start() {
        synchronized(lock) {
            if (socket != null || !api.isConfigured) return
            val ws = socketFactory(api)
            val pump = CoroutineScope(SupervisorJob() + dispatcher)
            socket = ws
            scope = pump
            ws.connect()
            pump.launch { ws.frames.collect { frame -> handle(ws, frame) } }
        }
    }

    /** Closes the socket. Collectors of [events] stay subscribed and resume after the next [start]. */
    fun stop() {
        synchronized(lock) {
            scope?.cancel()
            socket?.disconnect()
            scope = null
            socket = null
            _connected.value = false
        }
    }

    /** [stop] then [start] (e.g. after the client was re-pointed). */
    fun restart() {
        stop()
        start()
    }

    private fun handle(
        source: WebSocketClient,
        frame: WsFrame,
    ) {
        synchronized(lock) { if (source !== socket) return }
        when (frame) {
            WsFrame.Opened -> _connected.value = true
            is WsFrame.Closed -> _connected.value = false
            is WsFrame.Json -> _events.tryEmit(decode(frame.value))
            is WsFrame.Text, is WsFrame.Binary -> Unit
        }
    }

    companion object {
        /** The events socket's path. */
        const val PATH = "/ws/events"

        private const val EVENT_BUFFER = 256

        /** One frame as a [WsEvent]; anything that does not decode becomes [WsEvent.Unknown]. */
        fun decode(frame: JsonObject): WsEvent =
            try {
                OptioJson.decodeFromJsonElement(WsEvent.serializer(), frame)
            } catch (_: SerializationException) {
                WsEvent.Unknown(frame)
            } catch (_: IllegalArgumentException) {
                WsEvent.Unknown(frame)
            }
    }
}

/** Only the events of type [E] (e.g. `hub.on<TaskStateChangedEvent>()`). */
inline fun <reified E : WsEvent> EventHub.on(): Flow<E> = events.filterIsInstance<E>()

/**
 * The raw JSON of events whose `type` this app has no model for, e.g. `hub.unknown("local:changed")`
 * (published on `/ws/events` but not part of the TS `WsEvent` union).
 */
fun EventHub.unknown(type: String): Flow<JsonObject> =
    events.filterIsInstance<WsEvent.Unknown>()
        .filter { it.raw["type"]?.stringValue == type }
        .map { it.raw as JsonObject }
