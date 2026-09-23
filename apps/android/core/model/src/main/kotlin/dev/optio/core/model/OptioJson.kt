package dev.optio.core.model

import java.time.Instant
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json
import kotlinx.serialization.modules.SerializersModule
import kotlinx.serialization.modules.contextual

/**
 * The one kotlinx [Json] instance for Optio's wire format (REST bodies and WebSocket frames).
 * Decode the generated types in SharedTypes.kt with it.
 *
 * - `ignoreUnknownKeys`: a newer server may add fields an older app does not know.
 * - `explicitNulls = false`: an absent field decodes as `null` (or the property's default), and
 *   `null` properties are omitted when encoding, like Swift's `encodeIfPresent`.
 * - `coerceInputValues`: an explicit `null` for a non-null property with a default takes the
 *   default instead of failing.
 * - `isLenient`: tolerate quoted numbers/booleans and unquoted strings from older routes.
 * - `encodeDefaults = false`: request bodies only carry what the caller set, so a PATCH body
 *   never resets a field by omission.
 * - `@Contextual Instant` properties use [FlexibleInstantSerializer] (SharedTypes.kt applies it
 *   to every `Instant` on its own).
 *
 * Unknown enum values and unknown union variants never fail decoding: the generated enums fall
 * back to `UNKNOWN` ([RawEnumSerializer]) and the unions to `Unknown(raw)`
 * ([DiscriminatedUnionSerializer]).
 */
@OptIn(ExperimentalSerializationApi::class)
val OptioJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    coerceInputValues = true
    isLenient = true
    encodeDefaults = false
    serializersModule = SerializersModule {
        contextual(Instant::class, FlexibleInstantSerializer)
    }
}
