package dev.optio.feature.tasks.data

import dev.optio.core.model.FlexibleInstantSerializer
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeFormatter
import java.time.format.DateTimeParseException
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * A date on the row types of this module that never fails a decode: ISO-8601 (with or without
 * fractional seconds, any offset), Postgres' text form (`2026-09-23 00:46:26.671658+00`, which the
 * job routes' aggregate `lastRunAt` comes back as), or epoch seconds / milliseconds. Anything
 * else decodes as null instead of failing the whole screen (iOS `APIClient.decodeDate` throws on
 * the Postgres form, so a Job with runs fails to load there).
 */
object LenientInstantSerializer : KSerializer<Instant?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("dev.optio.feature.tasks.LenientInstant", PrimitiveKind.STRING).nullable

    override fun serialize(encoder: Encoder, value: Instant?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(FlexibleInstantSerializer.format(value))
    }

    override fun deserialize(decoder: Decoder): Instant? {
        if (decoder !is JsonDecoder) return parse(decoder.decodeString())
        val primitive = decoder.decodeJsonElement() as? JsonPrimitive ?: return null
        if (primitive is JsonNull) return null
        if (primitive.isString) return parse(primitive.content)
        return primitive.doubleOrNull?.let { runCatching { FlexibleInstantSerializer.fromEpoch(it) }.getOrNull() }
    }

    private val PG_OFFSET = Regex("([+-]\\d{2})$")
    private val PG_OFFSET_COMPACT = Regex("([+-]\\d{2})(\\d{2})$")

    /** [text] as an instant, or null when it isn't a date in any of the accepted forms. */
    fun parse(text: String): Instant? {
        val s = text.trim()
        if (s.isEmpty()) return null
        iso(s)?.let { return it }
        // Postgres text form: a space instead of `T`, and `+00` / `+0530` offsets.
        var normalized = if (s.length > 10 && s[10] == ' ') s.substring(0, 10) + "T" + s.substring(11) else s
        if ('T' !in normalized) return null
        normalized = when {
            PG_OFFSET_COMPACT.containsMatchIn(normalized) && !normalized.endsWith("Z") ->
                normalized.replace(PG_OFFSET_COMPACT, "$1:$2")
            PG_OFFSET.containsMatchIn(normalized) -> normalized.replace(PG_OFFSET, "$1:00")
            else -> normalized
        }
        iso(normalized)?.let { return it }
        // No offset at all: the server's clock is UTC.
        return iso(normalized + "Z")
    }

    private fun iso(text: String): Instant? = try {
        OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant()
    } catch (_: DateTimeParseException) {
        null
    }
}
