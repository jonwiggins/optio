package dev.optio.feature.widgets.model

import dev.optio.core.glance.GlanceCopy
import dev.optio.core.glance.GlanceEntry
import dev.optio.core.glance.GlanceItem
import dev.optio.core.glance.GlancePolicy
import dev.optio.core.glance.InFlightTask
import dev.optio.core.model.WatchItemKind
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.theme.StatusKind
import dev.optio.feature.widgets.work.WidgetSamples
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import org.junit.Test

/**
 * The Work board's data shaping (iOS `WorkWidget.swift`'s `extension GlanceEntry`) over
 * `:core:glance` entries built from the iOS fixtures: ranking, board counts and tiles, the head,
 * links, server labels and the honesty states.
 */
class WorkBoardTest {
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
        val followed = WidgetSamples.web(now).copy(id = task.id, kind = WatchItemKind.TASK)
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
        assertEquals(
            listOf(GlanceCopy.Tile.Id.NEEDS_YOU, GlanceCopy.Tile.Id.RUNNING, GlanceCopy.Tile.Id.WAITING, GlanceCopy.Tile.Id.RECURRING, GlanceCopy.Tile.Id.AGENTS),
            entry.boardTiles.map { it.id },
        )
        assertEquals(listOf(3, 3, 4, 8, 6), entry.boardTiles.map { it.count }, "row counts (tasks included), server tiles summed")
        assertEquals(listOf("active", "active", "active", "recurring", "agents"), entry.boardTiles.map { it.view })
        assertEquals(listOf(GlanceCopy.Tile.Id.NEEDS_YOU, GlanceCopy.Tile.Id.RUNNING), WidgetSamples.legacy(now).boardTiles.map { it.id }, "two honest tiles on an older server")
    }

    @Test
    fun linksCarryTheServerOnlyForASingleServerWidget() {
        assertEquals("optio://section/work?view=active", WidgetSamples.waiting(now).boardLink)
        val one = WidgetSamples.one(now)
        assertEquals("optio://section/work?view=active&server=srv-laptop", one.boardLink)
        val recurring = one.boardTiles.first { it.id == GlanceCopy.Tile.Id.RECURRING }
        assertEquals("optio://section/work?view=recurring&server=srv-laptop", one.tileLink(recurring))
    }

    @Test
    fun serverLabels() {
        val multi = WidgetSamples.waiting(now)
        assertTrue(multi.isMulti)
        assertNull(multi.server)
        assertEquals(WidgetSamples.studio, multi.serverProfile("srv-studio"))
        assertNull(multi.serverProfile("gone"))
        assertTrue(WidgetSamples.one(now).showsServerName, "another server is paired, so say which one this is")
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
        assertEquals(listOf("a-vesper", "t-web", "t-api"), entry.sessionRows.map { it.id })
    }

    @Test
    fun honesty() {
        assertEquals(GlancePolicy.Reachability.SIGNED_OUT, WidgetSamples.signedOut(now).reachability)
        val offline = WidgetSamples.offline(now)
        assertEquals(GlancePolicy.Reachability.UNREACHABLE, offline.reachability)
        assertEquals(now.minus(Duration.ofMinutes(41)), offline.unreachableSince)
        assertTrue(offline.isStale)
        val partial = WidgetSamples.partial(now)
        assertEquals(GlancePolicy.Reachability.LIVE, partial.reachability, "one live server keeps the widget live")
        assertEquals(listOf("srv-studio"), partial.unreachableSlices.map { it.server.id })
        assertTrue(WidgetSamples.stale(now).isStale)
        assertFalse(WidgetSamples.single(now).isStale)
    }

    @Test
    fun quietAndIdle() {
        val quiet = WidgetSamples.quiet(now)
        assertEquals(0, quiet.needsYouCount)
        assertEquals(3, quiet.runningCount)
        assertEquals(3 to "running", GlanceCopy.headlineCount(quiet.needsYouCount, quiet.runningCount))
        val idle = WidgetSamples.idle(now)
        assertTrue(idle.sessionRows.isEmpty())
        assertNull(idle.headSession)
        assertEquals(idle.boardLink, idle.headLink)
    }

    @Test
    fun taskRowsFromCapturedTasks() {
        // `GET /api/tasks?limit=8&type=repo-task` captured from the private test API.
        val tasks =
            Fixtures.decode<TasksPage>("tasks-repo.json").tasks
                .filter { it.state in InFlightTask.IN_FLIGHT_STATES }
                .map { it.copy(serverId = "srv", serverName = "DevLab") }
        val entry = GlanceEntry(now, listOf(WidgetSamples.slice(WidgetSamples.laptop.copy(id = "srv"), now, emptyList(), emptyList(), tasks = tasks)))
        val rows = entry.sessionRows
        // The queued task was updated last (it never started), so it leads the running rows.
        assertEquals(listOf("needs_attention", "queued", "running", "pr_opened"), rows.map { it.state }, "stuck first, then running (newest first), the open PR last")
        assertEquals(listOf("Stuck", "Queued", "running", "PR"), rows.map { it.statusWord })
        assertTrue(rows.all { it.link.startsWith("optio://tasks/") && it.link.endsWith("?server=srv") })
        // Where: the repo for pod runs, the machine's directory for the task that runs on the laptop.
        assertEquals(listOf("e2e-org/e2e-repo", "~/repos/e2e-repo", "e2e-org/mobile-app", "e2e-org/e2e-repo"), rows.map { it.whereValue.detail })
        assertEquals(listOf("pod", "machine", "pod", "pod"), rows.map { it.whereValue.target.raw })
        assertEquals(1, entry.needsYouCount)
        assertEquals(2, entry.runningCount, "running and queued run; the open PR waits")
    }

    @Serializable
    private data class TasksPage(val tasks: List<InFlightTask> = emptyList())

    @Test
    fun statusWordsAndColours() {
        fun item(
            state: String,
            reason: String? = null,
        ) = GlanceItem(kind = WatchItemKind.LOCAL, id = "i", title = "t", mono = "m", reason = reason, since = now, state = state, link = "optio://x")
        assertEquals("Allow?", item("needs_you", "permission").statusWord)
        assertEquals(StatusKind.NEEDS_INPUT, item("needs_you", "permission").statusKind)
        assertEquals("working", item("working").statusWord, "no badge: the session's own label")
        assertEquals(StatusKind.WORKING, item("working").statusKind)
        assertEquals(StatusKind.COMPLETED, item("pr_opened", "CI passed").statusKind, "the badge's colour wins over the state's")
        assertEquals(StatusKind.FAILED, item("failed").statusKind)
    }
}
