package dev.optio.core.model

import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.json.Json

/**
 * The one kotlinx [Json] instance for Optio's wire format (REST bodies and WebSocket frames).
 *
 * - `ignoreUnknownKeys`: a newer server may add fields an older app does not know.
 * - `explicitNulls = false`: absent and `null` fields both decode to the property's default, and
 *   nulls are omitted when encoding.
 * - `isLenient`: tolerate quoted numbers/booleans and unquoted strings from older routes.
 * - `encodeDefaults = false`: request bodies only carry what the caller set.
 *
 * Placeholder written by the scaffold: Agent T replaces this module's sources with the generated
 * wire types (`pnpm gen:kotlin`) and keeps this name.
 */
@OptIn(ExperimentalSerializationApi::class)
val OptioJson: Json = Json {
    ignoreUnknownKeys = true
    explicitNulls = false
    isLenient = true
    encodeDefaults = false
}
