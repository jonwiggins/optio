package dev.optio.feature.reviews

import dev.optio.core.model.FlexibleInstantSerializer
import java.time.Instant
import java.time.LocalDateTime
import java.time.OffsetDateTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.nullable
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.doubleOrNull

/**
 * Dates as the review and issue routes send them, read leniently: ISO-8601 (with or without
 * fractional seconds or an offset), Postgres text (`2026-09-23 00:47:43.464027+00`), or epoch
 * numbers. Rows come from Drizzle, GitHub and external ticket providers, and one odd date must
 * never fail a whole list, so anything unreadable is null.
 */
internal object ReviewDates {
    private val trailingHourOffset = Regex("[+-]\\d{2}$")

    fun parse(text: String?): Instant? {
        val raw = text?.trim()
        if (raw.isNullOrEmpty()) return null
        parseIso(raw)?.let { return it }
        val normalized = raw.replaceFirst(' ', 'T').let { if (trailingHourOffset.containsMatchIn(it)) "$it:00" else it }
        parseIso(normalized)?.let { return it }
        runCatching { return LocalDateTime.parse(normalized).toInstant(ZoneOffset.UTC) }
        return raw.toDoubleOrNull()?.let(FlexibleInstantSerializer::fromEpoch)
    }

    private fun parseIso(text: String): Instant? =
        runCatching { OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant() }.getOrNull()

    /** [instant] like `Date.toISOString()` (UTC, milliseconds): comparable as a string. */
    fun iso(instant: Instant): String = FlexibleInstantSerializer.format(instant)

    /** [raw] normalised to [iso] when it parses, else unchanged (so equal moments compare equal). */
    fun normalize(raw: String?): String = parse(raw)?.let(::iso) ?: raw.orEmpty()
}

/** [Instant]? decoded through [ReviewDates.parse]: unreadable values become null instead of failing. */
@OptIn(ExperimentalSerializationApi::class)
internal object LenientInstantSerializer : KSerializer<Instant?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("dev.optio.feature.reviews.LenientInstant", PrimitiveKind.STRING).nullable

    override fun deserialize(decoder: Decoder): Instant? {
        if (decoder !is JsonDecoder) return ReviewDates.parse(decoder.decodeString())
        val primitive = decoder.decodeJsonElement() as? JsonPrimitive ?: return null
        if (primitive.isString) return ReviewDates.parse(primitive.content)
        return primitive.doubleOrNull?.let(FlexibleInstantSerializer::fromEpoch)
    }

    override fun serialize(encoder: Encoder, value: Instant?) {
        if (value == null) encoder.encodeNull() else encoder.encodeString(ReviewDates.iso(value))
    }
}
