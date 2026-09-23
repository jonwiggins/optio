package dev.optio.feature.widgets.model

import dev.optio.feature.widgets.work.WidgetSamples
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Widget data shaping (iOS `GlanceEntry` + the `WorkWidget.swift` extension): ranking, board
 * counts and tiles, the head, server labels and the honesty states, on the iOS fixtures.
 */
class GlanceEntryTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")

    @Test
    fun rowsRankNeedsYouThenRunningThenOpenPrs() {
        val entry = WidgetSamples.waiting(now)
        // Needs you across servers, oldest first: Vesper 38m (failed), api 11m, web 4m.
        // Running, newest first: docs 2m, task-2 12m (a task row), cli 23m. Then the open PR.
        assertEquals(listOf("a-vesper", "t-api", "t-web", "t-docs", "task-2", "t-cli", "task-1"), entry.sessionRows.map { it.id })
        assertEquals(3, entry.needsYouCount)
        assertEquals(3, entry.runningCount, "the open PR waits; it is not running")
        assertEquals("a-vesper", entry.headSession?.id)
        assertEquals(entry.headSession?.link, entry.headLink)
    }

    @Test
    fun taskRowsSkipTasksAlreadyInTheSnapshot() {
        val task = WidgetSamples.tasks(now)[0]
        val followed = WidgetSamples.web(now).copy(id = task.id, kind = dev.optio.core.model.WatchItemKind.TASK)
        val entry = GlanceEntry(now, listOf(WidgetSamples.slice(WidgetSamples.laptop, now, needs = listOf(followed), running = emptyList(), tasks = listOf(task))))
        assertEquals(listOf(task.id), entry.sessionRows.map { it.id }, "one row, not two")
    }

    @Test
    fun taskRowsCarryTheFourAttributes() {
        val entry = WidgetSamples.single(now)
        val pr = entry.taskRows.first { it.id == "task-1" }
        assertEquals("fix/login-redirect", pr.rowName)
        assertEquals("optio://tasks/task-1?server=srv-laptop", pr.link)
        assertEquals("jonwiggins/optio", pr.whereValue.detail)
        assertEquals("Claude Code", GlanceCopy.whoLabel(pr.whoValue))
        assertEquals("PR", pr.statusWord)
        assertEquals(now.minus(Duration.ofMinutes(52)), pr.since)

        val failing = GlanceEntry(now, listOf(WidgetSamples.slice(WidgetSamples.laptop, now, emptyList(), emptyList(), tasks = listOf(WidgetSamples.tasks(now)[0].copy(prChecksStatus = "failing")))))
        assertEquals("CI", failing.sessionRows.single().statusWord)
        val noDates = GlanceEntry(now, listOf(WidgetSamples.slice(WidgetSamples.laptop, now, emptyList(), emptyList(), tasks = listOf(WidgetSamples.tasks(now)[1].copy(startedAt = null)))))
        assertEquals(now, noDates.sessionRows.single().since, "a task without dates is 'now'")
    }

    @Test
    fun tilesComeFromTheRowsAndTheServer() {
        val entry = WidgetSamples.waiting(now)
        assertEquals(listOf(GlanceCopy.Tile.Id.NEEDS_YOU, GlanceCopy.Tile.Id.RUNNING, GlanceCopy.Tile.Id.WAITING, GlanceCopy.Tile.Id.RECURRING, GlanceCopy.Tile.Id.AGENTS), entry.tiles.map { it.id })
        assertEquals(listOf(3, 3, 4, 8, 6), entry.tiles.map { it.count }, "server tiles summed across both laptops")
        assertEquals(listOf("active", "active", "active", "recurring", "agents"), entry.tiles.map { it.view })

        val legacy = WidgetSamples.legacy(now)
        assertEquals(listOf(GlanceCopy.Tile.Id.NEEDS_YOU, GlanceCopy.Tile.Id.RUNNING), legacy.tiles.map { it.id }, "two honest tiles on an older server")
    }

    @Test
    fun linksCarryTheServerOnlyForASingleServerWidget() {
        assertEquals("optio://section/work?view=active", WidgetSamples.waiting(now).boardLink)
        assertEquals("optio://section/work?view=active&server=srv-laptop", WidgetSamples.one(now).boardLink)
        val recurring = WidgetSamples.one(now).tiles.first { it.id == GlanceCopy.Tile.Id.RECURRING }
        assertEquals("optio://section/work?view=recurring&server=srv-laptop", WidgetSamples.one(now).tileLink(recurring))
    }

    @Test
    fun serverLabels() {
        val multi = WidgetSamples.waiting(now)
        assertTrue(multi.isMulti)
        assertNull(multi.server)
        assertFalse(multi.showsServerName)
        assertEquals(WidgetSamples.studio, multi.serverProfile("srv-studio"))

        val one = WidgetSamples.one(now)
        assertFalse(one.isMulti)
        assertEquals(WidgetSamples.laptop, one.server)
        assertTrue(one.showsServerName, "another server is paired, so say which one this is")

        assertFalse(WidgetSamples.single(now).showsServerName, "the only paired server needs no name")
    }

    @Test
    fun mergedNeedsYouPutsSnoozedItemsLast() {
        val snoozedApi = WidgetSamples.api(now).copy(snoozedUntil = now.plus(Duration.ofMinutes(10)))
        val entry =
            GlanceEntry(
                now,
                listOf(
                    WidgetSamples.slice(WidgetSamples.laptop, now, needs = listOf(WidgetSamples.web(now), snoozedApi), running = emptyList()),
                    WidgetSamples.slice(WidgetSamples.studio, now, needs = listOf(WidgetSamples.forge(now)), running = emptyList()),
                ),
            )
        assertEquals(listOf("a-vesper", "t-web", "t-api"), entry.needsYou.map { it.id })
    }

    @Test
    fun reachabilityAndHonesty() {
        assertEquals(GlancePolicy.Reachability.SIGNED_OUT, WidgetSamples.signedOut(now).reachability)

        val offline = WidgetSamples.offline(now)
        assertEquals(GlancePolicy.Reachability.UNREACHABLE, offline.reachability)
        assertEquals(now.minus(Duration.ofMinutes(41)), offline.unreachableSince)
        assertTrue(offline.isStale, "47 minutes old")

        val partial = WidgetSamples.partial(now)
        assertEquals(GlancePolicy.Reachability.LIVE, partial.reachability, "one live server keeps the widget live")
        assertEquals(listOf("srv-studio"), partial.unreachableSlices.map { it.server.id })
        assertEquals(now.minus(Duration.ofMinutes(20)), partial.asOf, "only as fresh as the oldest slice")

        assertTrue(WidgetSamples.stale(now).isStale)
        assertFalse(WidgetSamples.single(now).isStale)
    }

    @Test
    fun quietAndIdle() {
        val quiet = WidgetSamples.quiet(now)
        assertEquals(0, quiet.needsYouCount)
        assertEquals(3, quiet.runningCount)
        assertEquals(GlanceCopy.Headline(3, "running"), GlanceCopy.headlineCount(quiet.needsYouCount, quiet.runningCount))

        val idle = WidgetSamples.idle(now)
        assertTrue(idle.sessionRows.isEmpty())
        assertNull(idle.headSession)
        assertEquals(idle.boardLink, idle.headLink)
        assertNull(GlanceCopy.headlineCount(idle.needsYouCount, idle.runningCount))
    }
}
