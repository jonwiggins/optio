package dev.optio.core.network

import dev.optio.core.model.OptioJson
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.decodeFromJsonElement

/**
 * What a [WebSocketClient] delivers (iOS `WebSocketClient.Frame`). Text frames that parse as a
 * JSON object arrive as [Json], other text as [Text], binary frames as [Binary]. [Opened] and
 * [Closed] bracket each connection; after an auto-reconnect a new [Opened] follows.
 */
sealed interface WsFrame {
    /** A text frame holding a JSON object. */
    data class Json(val value: JsonObject) : WsFrame {
        /** [value] decoded as [T] with [OptioJson]; throws `SerializationException` if it does not fit. */
        inline fun <reified T> decode(): T = OptioJson.decodeFromJsonElement(value)
    }

    /** A text frame that is not a JSON object. */
    data class Text(val text: String) : WsFrame

    /** A binary frame (e.g. terminal output). */
    class Binary(val bytes: ByteArray) : WsFrame {
        override fun equals(other: Any?): Boolean = other is Binary && bytes.contentEquals(other.bytes)

        override fun hashCode(): Int = bytes.contentHashCode()

        override fun toString(): String = "Binary(${bytes.size} bytes)"
    }

    /** The upgrade succeeded; frames follow. */
    data object Opened : WsFrame

    /**
     * The connection ended: the server's close [code] (e.g. 4401 unauthorized), or 1006 when it
     * dropped without a close frame (network loss, failed handshake). Not emitted after
     * [WebSocketClient.disconnect].
     */
    data class Closed(val code: Int, val reason: String?) : WsFrame
}
