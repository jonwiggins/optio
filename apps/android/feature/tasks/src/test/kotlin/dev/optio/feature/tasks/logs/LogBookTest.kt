package dev.optio.feature.tasks.logs

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.ui.log.TaskLogRow
import dev.optio.feature.tasks.logs.LogBook.Origin.LIVE
import dev.optio.feature.tasks.logs.LogBook.Origin.LOCAL
import dev.optio.feature.tasks.logs.LogBook.Origin.STORED
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/**
 * The merge rules of a log (REST rows, live frames, local lines): no duplicates when a line
 * arrives both ways, typed rows replace their untyped live twins, gaps are filled in time order.
 */
class LogBookTest {
    private val t0 = Instant.parse("2026-09-23T00:46:10.000Z")

    private fun at(ms: Long) = t0.plusMillis(ms).toString()

    private fun row(id: String, content: String, ms: Long, type: String = "text") =
        TaskLogRow(id = id, content = content, logType = type, timestamp = at(ms))

    private fun live(content: String, ms: Long, type: AgentLogEntry.TypeValue = AgentLogEntry.TypeValue.TEXT) =
        AgentLogEntry(taskId = "t", timestamp = at(ms), type = type, content = content)

    @Test
    fun historyThenLiveKeepsOrder() {
        val book = LogBook("t")
        book.addStored(listOf(row("1", "a", 0), row("2", "b", 10)))
        assertTrue(book.addLive(live("c", 20)))
        assertEquals(listOf("a", "b", "c"), book.entries.map { it.content })
        assertEquals(listOf(STORED, STORED, LIVE), book.origins())
        assertEquals(2, book.storedCount)
    }

    @Test
    fun liveFramesBeforeHistoryMergeWithoutDuplicates() {
        // The socket delivers "b" and "c" while the REST fetch runs; REST has a, b.
        val book = LogBook("t")
        book.addLive(live("b", 10))
        book.addLive(live("c", 20))
        book.addStored(listOf(row("1", "a", 0), row("2", "b", 10)))
        assertEquals(listOf("a", "b", "c"), book.entries.map { it.content })
        assertEquals(listOf(STORED, STORED, LIVE), book.origins())
    }

    @Test
    fun aLiveFrameStampedByAnotherClockStillMatchesItsRow() {
        // Task logs: the live frame is stamped a few ms after the row's database time, untyped.
        val book = LogBook("t")
        book.addLive(live("{\"command\":\"ls\"}", 12))
        book.addStored(listOf(row("1", "{\"command\":\"ls\"}", 3, type = "tool_use")))
        assertEquals(1, book.size)
        assertEquals(AgentLogEntry.TypeValue.TOOL_USE, book.entries.single().type, "the typed row replaces the untyped frame")
        assertFalse(book.hasPendingLive)
    }

    @Test
    fun aRowFetchedBeforeItsLiveFrameAbsorbsIt() {
        val book = LogBook("t")
        book.addStored(listOf(row("1", "a", 0)))
        assertFalse(book.addLive(live("a", 4)), "already have it")
        assertEquals(1, book.size)
        // …but only once: the agent printing "a" again later is a new line.
        assertTrue(book.addLive(live("a", 9_000)))
        assertEquals(2, book.size)
    }

    @Test
    fun repeatedLinesStayRepeated() {
        val book = LogBook("t")
        book.addLive(live("Done", 0))
        book.addLive(live("Done", 500))
        book.addStored(listOf(row("1", "Done", 0), row("2", "Done", 500)))
        assertEquals(listOf("Done", "Done"), book.entries.map { it.content })
        assertEquals(listOf(STORED, STORED), book.origins())
    }

    @Test
    fun anExactRepeatOfTheLastFrameIsDropped() {
        val book = LogBook("t")
        book.addStored(emptyList())
        assertTrue(book.addLive(live("x", 0)))
        assertFalse(book.addLive(live("x", 0)))
        assertEquals(1, book.size)
    }

    @Test
    fun gapRowsAreInsertedInTimeOrder() {
        // Socket down between 10 and 40: the frames at 20 and 30 were missed, "e" arrived live after.
        val book = LogBook("t")
        book.addStored(listOf(row("1", "a", 0), row("2", "b", 10)))
        book.addLive(live("e", 40))
        book.addStored(listOf(row("3", "c", 20), row("4", "d", 30), row("5", "e", 40)))
        assertEquals(listOf("a", "b", "c", "d", "e"), book.entries.map { it.content })
        assertEquals(5, book.storedCount)
        assertFalse(book.hasPendingLive)
    }

    @Test
    fun knownRowsAreSkippedSoAFullRefetchAddsNothing() {
        val book = LogBook("t")
        val rows = listOf(row("1", "a", 0), row("2", "b", 10))
        assertTrue(book.addStored(rows))
        assertFalse(book.addStored(rows))
        assertEquals(2, book.size)
        assertEquals(2, book.storedCount)
    }

    @Test
    fun localLinesStayWhereTheyWereTyped() {
        val book = LogBook("t")
        book.addStored(listOf(row("1", "a", 0)))
        book.addLocal(LogStream.localEntry("t", "please continue", interrupt = false, now = Instant.parse("2030-01-01T00:00:00Z")))
        book.addLive(live("b", 10))
        book.addStored(listOf(row("2", "b", 10)))
        assertEquals(listOf("a", "please continue", "b"), book.entries.map { it.content })
        assertEquals(listOf(STORED, LOCAL, STORED), book.origins())
        assertEquals("user", book.entries[1].metadata?.get("role")?.let { (it as kotlinx.serialization.json.JsonPrimitive).content })
    }

    @Test
    fun interruptsAreMarked() {
        assertEquals("[interrupt] stop", LogStream.localEntry("t", "stop", interrupt = true, now = t0).content)
    }

    @Test
    fun clearForgetsEverything() {
        val book = LogBook("t")
        book.addStored(listOf(row("1", "a", 0)))
        book.addLive(live("b", 10))
        book.clear()
        assertEquals(0, book.size)
        assertEquals(0, book.storedCount)
        assertTrue(book.addStored(listOf(row("1", "a", 0))), "ids are forgotten too")
    }
}
