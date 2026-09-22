package dev.optio.core.network

import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.OptioJson
import dev.optio.core.model.RawEnum
import java.lang.reflect.Modifier
import java.time.Instant
import java.util.concurrent.ConcurrentHashMap
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/**
 * Turns a request body of any supported type into JSON, so [ApiClient]'s calls take a plain
 * `body: Any?` (like iOS's `some Encodable`) instead of a second type argument:
 *
 * - [JsonElement] is sent as is (build a `JsonObject` to send an explicit `null`).
 * - `Map<String, *>` becomes an object and `Iterable` / `Array` an array; their `null` values are
 *   sent as JSON `null` (unlike generated types, which omit nulls).
 * - `String`, `Number`, `Boolean`, generated enums ([RawEnum] → `raw`) and [Instant] (ISO-8601,
 *   like `Date.toISOString()`) become primitives.
 * - Anything else must be `@Serializable`; it is encoded with [OptioJson] (nulls and defaults
 *   omitted). Its serializer is found reflectively once per class and cached.
 */
internal object JsonBodies {
    private val serializers = ConcurrentHashMap<Class<*>, KSerializer<Any>>()

    fun encode(value: Any): ByteArray =
        OptioJson.encodeToString(JsonElement.serializer(), toJsonElement(value)).encodeToByteArray()

    fun toJsonElement(value: Any?): JsonElement =
        when (value) {
            null -> JsonNull
            is JsonElement -> value
            is String -> JsonPrimitive(value)
            is Boolean -> JsonPrimitive(value)
            is Number -> JsonPrimitive(value)
            is Char -> JsonPrimitive(value.toString())
            is RawEnum -> JsonPrimitive(value.raw)
            is Instant -> JsonPrimitive(FlexibleInstantSerializer.format(value))
            is Map<*, *> -> JsonObject(value.entries.associate { (key, item) -> key.toString() to toJsonElement(item) })
            is Iterable<*> -> JsonArray(value.map(::toJsonElement))
            is Array<*> -> JsonArray(value.map(::toJsonElement))
            else -> OptioJson.encodeToJsonElement(serializerFor(value.javaClass), value)
        }

    private fun serializerFor(type: Class<*>): KSerializer<Any> =
        serializers.getOrPut(type) {
            lookUp(type) ?: throw IllegalArgumentException(
                "Request body ${type.name} is not @Serializable: annotate it, or pass a JsonElement / Map.",
            )
        }

    /**
     * The compiled serializer of [type]. kotlinx's reflective lookup handles public and internal
     * classes; a `private` class (package-private in bytecode) needs its companion's `serializer()`
     * called with access checks off.
     */
    @Suppress("UNCHECKED_CAST")
    private fun lookUp(type: Class<*>): KSerializer<Any>? {
        try {
            return OptioJson.serializersModule.serializer(type)
        } catch (_: SerializationException) {
            // fall through
        } catch (_: IllegalArgumentException) {
            // fall through
        } catch (_: IllegalAccessException) {
            // fall through
        }
        return runCatching {
            val holder =
                type.declaredFields.firstOrNull { it.name == "Companion" && Modifier.isStatic(it.modifiers) }
                    ?.apply { isAccessible = true }?.get(null)
                    ?: type.declaredFields.firstOrNull { it.name == "INSTANCE" && Modifier.isStatic(it.modifiers) }
                        ?.apply { isAccessible = true }?.get(null)
                    ?: return null
            val method = holder.javaClass.getDeclaredMethod("serializer").apply { isAccessible = true }
            method.invoke(holder) as? KSerializer<Any>
        }.getOrNull()
    }
}
