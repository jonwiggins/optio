package dev.optio.core.model

import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlinx.serialization.Contextual
import kotlinx.serialization.SerializationException
import kotlinx.serialization.Serializable
import org.junit.Test

/** The rules of the iOS `APIClient.decodeDate`, plus how dates are written back. */
class FlexibleInstantSerializerTest {
    private fun at(json: String): Instant? =
        OptioJson.decodeFromString(TaskEvent.serializer(), taskEvent(json)).createdAt

    /** A generated struct with a `Date` field, so the file-level `UseSerializers` is exercised. */
    private fun taskEvent(createdAt: String) =
        """{"id":"e","taskId":"t","toState":"queued","trigger":"retry","createdAt":$createdAt}"""

    @Test
    fun isoWithFractionalSeconds() {
        assertEquals(Instant.parse("2026-09-17T10:20:30.123Z"), at("\"2026-09-17T10:20:30.123Z\""))
        assertEquals(Instant.parse("2026-09-17T10:20:30.123456Z"), at("\"2026-09-17T10:20:30.123456Z\""))
    }

    @Test
    fun isoWithoutFractionalSeconds() {
        assertEquals(Instant.parse("2026-09-17T10:20:30Z"), at("\"2026-09-17T10:20:30Z\""))
    }

    @Test
    fun isoWithAnOffset() {
        assertEquals(Instant.parse("2026-09-17T10:20:30Z"), at("\"2026-09-17T12:20:30+02:00\""))
        assertEquals(Instant.parse("2026-09-17T10:20:30.5Z"), at("\"2026-09-17T05:20:30.500-05:00\""))
    }

    @Test
    fun epochMillisecondsAndSeconds() {
        assertEquals(Instant.ofEpochMilli(1789640430123), at("1789640430123"))
        assertEquals(Instant.ofEpochSecond(1789640430), at("1789640430"))
        assertEquals(Instant.ofEpochSecond(1789640430, 500_000_000), at("1789640430.5"))
        // The same 1e11 cut-over as iOS: anything larger is milliseconds.
        assertEquals(Instant.ofEpochMilli(100_000_000_001), at("100000000001"))
        assertEquals(Instant.ofEpochSecond(100_000_000_000), at("100000000000"))
    }

    @Test
    fun rejectsWhatIosRejects() {
        for (bad in listOf("\"yesterday\"", "\"2026-09-17T10:20:30\"", "\"2026-09-17\"", "true", "{}")) {
            assertFailsWith<SerializationException>(bad) { at(bad) }
        }
    }

    @Test
    fun nullableDatesAcceptNullAndAbsence() {
        val json = """{"id":"t","workflowId":"w","enabled":true,"type":"manual",
            "lastFiredAt":null,"createdAt":"2026-09-17T10:20:30Z","updatedAt":1789640430123}"""
        val trigger = OptioJson.decodeFromString(WorkflowTrigger.serializer(), json)
        assertNull(trigger.lastFiredAt)
        assertNull(trigger.nextFireAt)
        assertEquals(Instant.ofEpochMilli(1789640430123), trigger.updatedAt)
    }

    @Test
    fun writesMillisecondIsoLikeDateToIsoString() {
        assertEquals("2026-09-17T10:20:30.123Z", FlexibleInstantSerializer.format(Instant.parse("2026-09-17T10:20:30.123456Z")))
        assertEquals("2026-09-17T10:20:30.000Z", FlexibleInstantSerializer.format(Instant.parse("2026-09-17T10:20:30Z")))
        val event = TaskEvent(
            id = "e",
            taskId = "t",
            toState = TaskState.QUEUED,
            trigger = "retry",
            createdAt = Instant.parse("2026-09-17T10:20:30Z"),
        )
        val json = OptioJson.encodeToString(TaskEvent.serializer(), event)
        assertEquals(
            """{"id":"e","taskId":"t","toState":"queued","trigger":"retry","createdAt":"2026-09-17T10:20:30.000Z"}""",
            json,
        )
        assertEquals(event, OptioJson.decodeFromString(TaskEvent.serializer(), json))
    }

    @Serializable
    private data class Stamped(@Contextual val at: Instant)

    @Test
    fun optioJsonServesContextualInstants() {
        val stamped = OptioJson.decodeFromString(Stamped.serializer(), """{"at":1789640430123}""")
        assertEquals(Instant.ofEpochMilli(1789640430123), stamped.at)
        assertEquals("""{"at":"2026-09-17T10:20:30.123Z"}""", OptioJson.encodeToString(Stamped.serializer(), stamped))
    }
}
