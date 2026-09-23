package dev.optio.feature.insights

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

/**
 * Dates as the analytics and cluster routes send them: ISO-8601 from Drizzle rows and Kubernetes,
 * but raw SQL rows (`/api/analytics/costs` top tasks and anomalies) come back as Postgres text,
 * `2026-09-23 00:47:43.464027+00`. Anything unreadable is null.
 */
internal object InsightsDates {
    private val trailingHourOffset = Regex("[+-]\\d{2}$")

    fun parse(text: String?): Instant? {
        val raw = text?.trim()
        if (raw.isNullOrEmpty()) return null
        parseIso(raw)?.let { return it }
        val normalized = raw.replaceFirst(' ', 'T').let { if (trailingHourOffset.containsMatchIn(it)) "$it:00" else it }
        parseIso(normalized)?.let { return it }
        runCatching { return LocalDateTime.parse(normalized).toInstant(ZoneOffset.UTC) }
        return null
    }

    private fun parseIso(text: String): Instant? =
        runCatching { OffsetDateTime.parse(text, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant() }.getOrNull()

    fun iso(instant: Instant): String = FlexibleInstantSerializer.format(instant)
}

/**
 * A number the server sends either as a JSON number or as a numeric string (cluster
 * `memoryUsedGi: "8.8"`, node `cpu: "10"`; iOS `LooseDouble`). Anything else is null.
 */
@OptIn(ExperimentalSerializationApi::class)
internal object LooseDoubleSerializer : KSerializer<Double?> {
    override val descriptor: SerialDescriptor =
        PrimitiveSerialDescriptor("dev.optio.feature.insights.LooseDouble", PrimitiveKind.DOUBLE).nullable

    override fun deserialize(decoder: Decoder): Double? {
        if (decoder !is JsonDecoder) return decoder.decodeString().toDoubleOrNull()
        val primitive = decoder.decodeJsonElement() as? JsonPrimitive ?: return null
        return primitive.content.takeUnless { primitive is kotlinx.serialization.json.JsonNull }?.toDoubleOrNull()
    }

    override fun serialize(encoder: Encoder, value: Double?) {
        if (value == null) encoder.encodeNull() else encoder.encodeDouble(value)
    }
}
