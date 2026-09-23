package dev.optio.core.model

import kotlin.math.abs
import kotlin.math.floor
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Hand-written companion to SharedTypes.kt. TypeScript `unknown` / `any` / irregular shapes are
// `JsonElement` here, where iOS has `AnyCodable` (apps/ios/Optio/Generated/AnyCodable.swift). These
// accessors mirror AnyCodable's, so ported code reads the same:
//   Swift:  entry.metadata?["toolName"]?.stringValue
//   Kotlin: entry.metadata?.get("toolName")?.stringValue

/** True for JSON `null`. */
val JsonElement.isNull: Boolean
    get() = this is JsonNull

/** A JSON boolean; null for anything else (the string `"true"` included). */
val JsonElement.boolValue: Boolean?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString || it is JsonNull }
        ?.content?.toBooleanStrictOrNull()

/** A JSON number; null for anything else (numeric strings included). */
val JsonElement.doubleValue: Double?
    get() = (this as? JsonPrimitive)?.takeUnless { it.isString || it is JsonNull }
        ?.content?.toDoubleOrNull()

/** A whole JSON number that fits an [Int] (`3` and `3.0`, not `3.5`); null otherwise. */
val JsonElement.intValue: Int?
    get() = longValue?.takeIf { it in Int.MIN_VALUE..Int.MAX_VALUE }?.toInt()

/** A whole JSON number: any integer literal that fits a [Long], or a whole double within ±2^53. */
val JsonElement.longValue: Long?
    get() {
        val primitive = (this as? JsonPrimitive)?.takeUnless { it.isString || it is JsonNull }
            ?: return null
        primitive.content.toLongOrNull()?.let { return it }
        val value = primitive.content.toDoubleOrNull() ?: return null
        return if (floor(value) == value && abs(value) < 9.007_199_254_740_992e15) value.toLong() else null
    }

/** A JSON string; null for anything else. */
val JsonElement.stringValue: String?
    get() = (this as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A JSON array's elements; null for anything else. */
val JsonElement.arrayValue: List<JsonElement>?
    get() = this as? JsonArray

/** A JSON object's members; null for anything else. */
val JsonElement.objectValue: Map<String, JsonElement>?
    get() = this as? JsonObject

/** Member lookup on objects; null for anything else or a missing key. */
operator fun JsonElement.get(key: String): JsonElement? = (this as? JsonObject)?.get(key)

/** Element lookup on arrays; null for anything else or an out-of-range index. */
operator fun JsonElement.get(index: Int): JsonElement? = (this as? JsonArray)?.getOrNull(index)
