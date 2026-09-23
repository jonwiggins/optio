package dev.optio.core.glance

import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.minutes

/**
 * The checks of iOS `apps/ios/scripts/test-glance-policy.sh` (GlancePolicy + GlanceCopy), one for
 * one, plus the Watch copy and the row badge vocabulary.
 */
class GlancePolicyCopyTest {
    private val now = Instant.ofEpochSecond(1_800_000_000)
    private val m = 60L

    private fun ago(seconds: Long) = now.minusSeconds(seconds)

    @Test
    fun refreshCadence() {
        assertEquals(5.minutes, GlancePolicy.refreshInterval(GlancePolicy.Reachability.LIVE, anyRunning = true, anyNeedsYou = false), "5 min while running")
        assertEquals(5.minutes, GlancePolicy.refreshInterval(GlancePolicy.Reachability.LIVE, anyRunning = false, anyNeedsYou = true), "5 min while waiting")
        assertEquals(15.minutes, GlancePolicy.refreshInterval(GlancePolicy.Reachability.LIVE, anyRunning = false, anyNeedsYou = false), "15 min when quiet")
        assertEquals(60.minutes, GlancePolicy.refreshInterval(GlancePolicy.Reachability.SIGNED_OUT, anyRunning = true, anyNeedsYou = true), "60 min signed out")
        assertEquals(60.minutes, GlancePolicy.refreshInterval(GlancePolicy.Reachability.UNREACHABLE, anyRunning = true, anyNeedsYou = true), "60 min unreachable")
    }

    @Test
    fun staleness() {
        assertFalse(GlancePolicy.isStale(ago(19 * m), now), "19 min is fresh")
        assertTrue(GlancePolicy.isStale(ago(21 * m), now), "21 min is stale")
    }

    @Test
    fun snoozeOrdering() {
        val items = listOf("web", "api", "cli", "docs")
        val snoozes = mapOf("web" to now.plusSeconds(10 * m), "cli" to now.minusSeconds(1))
        assertEquals(listOf("api", "cli", "docs", "web"), GlancePolicy.applySnooze(items, { it }, snoozes, now), "snoozed to back")
        assertEquals(items, GlancePolicy.applySnooze(items, { it }, emptyMap(), now), "no snoozes → unchanged")
        assertTrue(GlancePolicy.applySnooze(emptyList<String>(), { it }, snoozes, now).isEmpty(), "empty stays empty")
    }

    @Test
    fun runWidgetFlashes() {
        assertTrue(GlancePolicy.showsStarted(ago(2), now), "started 2 s ago shows")
        assertFalse(GlancePolicy.showsStarted(ago(61), now), "started 61 s ago hides")
        assertFalse(GlancePolicy.showsStarted(null, now), "never started hides")
        assertTrue(GlancePolicy.isArmed(ago(3), now), "armed 3 s ago")
        assertFalse(GlancePolicy.isArmed(ago(11), now), "arm expired")
    }

    @Test
    fun waitText() {
        assertEquals("now", GlancePolicy.waitText(ago(30), now))
        assertEquals("4m", GlancePolicy.waitText(ago(4 * m), now))
        assertEquals("2h", GlancePolicy.waitText(ago(2 * 3600), now))
        assertEquals("3d", GlancePolicy.waitText(ago(3 * 86400), now))
        assertEquals("now", GlancePolicy.waitText(now.plusSeconds(90), now), "a future since clamps to now")
    }

    @Test
    fun countsLine() {
        assertEquals("2 need you · 3 running", GlanceCopy.countsLine(2, 3))
        assertEquals("1 needs you", GlanceCopy.countsLine(1, 0))
        assertEquals("1 running", GlanceCopy.countsLine(0, 1))
        assertEquals("Quiet", GlanceCopy.countsLine(0, 0))
        assertEquals("2 more need you · 2 running", GlanceCopy.countsLine(3, 2, excludingHead = true))
        assertEquals("1 more needs you", GlanceCopy.countsLine(2, 0, excludingHead = true))
        assertEquals("", GlanceCopy.countsLine(1, 0, excludingHead = true), "nothing beyond the head → empty")
        assertEquals("3 running", GlanceCopy.countsLine(1, 3, excludingHead = true))
    }

    @Test
    fun headlineCount() {
        assertEquals(2 to "need you", GlanceCopy.headlineCount(2, 5))
        assertEquals(1 to "needs you", GlanceCopy.headlineCount(1, 5))
        assertEquals(5 to "running", GlanceCopy.headlineCount(0, 5))
        assertNull(GlanceCopy.headlineCount(0, 0))
    }

    @Test
    fun watchHeadlinesCompactAndWorkingLine() {
        assertEquals("1 session needs you", GlanceCopy.headline(WatchPhase.WAITING, 1, 0))
        assertEquals("3 sessions need you", GlanceCopy.headline(WatchPhase.WAITING, 3, 2))
        assertEquals("Nothing needs you · 3 running", GlanceCopy.headline(WatchPhase.WORKING, 0, 3))
        assertEquals("Nothing needs you", GlanceCopy.headline(WatchPhase.WORKING, 0, 0))
        assertEquals("Machine unreachable", GlanceCopy.headline(WatchPhase.OFFLINE, 0, 0))
        assertEquals("Sessions ended", GlanceCopy.headline(WatchPhase.DONE, 0, 0))
        assertEquals("+2", GlanceCopy.compactTrailing(WatchPhase.WAITING, 3, 0))
        assertEquals("", GlanceCopy.compactTrailing(WatchPhase.WAITING, 1, 0))
        assertEquals("4", GlanceCopy.compactTrailing(WatchPhase.WORKING, 0, 4))
        assertEquals("quiet", GlanceCopy.workingLine(0))
        assertEquals("1 session running", GlanceCopy.workingLine(1))
        assertEquals("3 sessions running", GlanceCopy.workingLine(3))
    }

    @Test
    fun inline() {
        assertEquals("Optio · web Allow? +2", GlanceCopy.inline("Optio", "web", "Allow?", 3, 1))
        assertEquals("Optio · web needs you", GlanceCopy.inline("Optio", "web", null, 1, 1))
        assertEquals("Optio · 2 running", GlanceCopy.inline("Optio", null, null, 0, 2))
        assertEquals("Optio · MBP · quiet", GlanceCopy.inline("Optio · MBP", null, null, 0, 0))
    }

    @Test
    fun boardTiles() {
        val two = GlanceCopy.tiles(1, 2, null, null, null)
        assertEquals(listOf(GlanceCopy.Tile.Id.NEEDS_YOU, GlanceCopy.Tile.Id.RUNNING), two.map { it.id }, "legacy server → two tiles")
        val five = GlanceCopy.tiles(1, 2, 3, 4, 5)
        assertEquals(GlanceCopy.Tile.Id.entries.toList(), five.map { it.id }, "five tiles in board order")
        assertEquals(listOf(1, 2, 3, 4, 5), five.map { it.count })
        assertEquals(listOf("active", "active", "active", "recurring", "agents"), five.map { it.view })
        assertEquals(listOf("Need you", "Running", "Waiting", "Recurring", "Agents"), five.map { it.label })
        assertEquals("optio://section/work?view=recurring&server=s1", five[3].link("s1"))
    }

    @Test
    fun chips() {
        assertEquals("Claude Code", GlanceCopy.whoLabel("claude-code"))
        assertEquals("terminal", GlanceCopy.whoLabel("terminal"))
        assertEquals("mystery", GlanceCopy.whoLabel("mystery"))
        assertEquals("MacBook Pro · web", GlanceCopy.whereLabel("MacBook Pro · ~/repos/optio/apps/web", "machine", short = true))
        assertEquals("MacBook Pro · ~/repos/optio/apps/web", GlanceCopy.whereLabel("MacBook Pro · ~/repos/optio/apps/web", "machine", short = false))
        assertEquals("optio", GlanceCopy.whereLabel("jonwiggins/optio", "pod", short = true))
        assertEquals("@vesper", GlanceCopy.whereLabel("@vesper", "pod", short = true))
        assertEquals("Optio pod", GlanceCopy.whereLabel(null, "pod", short = true))
        assertEquals("machine", GlanceCopy.whereLabel("", "machine", short = true))
    }

    // region Watch copy (iOS WatchCopy)

    @Test
    fun statusLineJoinsStatusAndReasonUnlessRedundant() {
        val needs = row(state = "needs_you", reason = "Waiting on a permission", statusLabel = "needs you")
        assertEquals("needs you · Waiting on a permission", WatchCopy.statusLine(needs))
        val pr = row(kind = WatchItemKind.TASK, state = "pr_opened", reason = "PR #581 open · CI running", statusLabel = "PR open")
        assertEquals("PR #581 open · CI running", WatchCopy.statusLine(pr), "a reason opening with the status word stands alone")
        assertEquals("working", WatchCopy.statusLine(row(state = "working", reason = null, statusLabel = "working")))
    }

    @Test
    fun watchCountsLineAndHeadlines() {
        val waiting = GlanceWatchState(WatchPhase.WAITING, head = row(), needsYouCount = 3, runningCount = 2)
        assertEquals("2 more need you · 2 running", WatchCopy.countsLine(waiting))
        assertEquals("3 sessions need you", WatchCopy.headline(waiting))
        assertEquals("Needs you", WatchCopy.shortHeadline(waiting))
        val working = GlanceWatchState(WatchPhase.WORKING, head = row(state = "working"), runningCount = 3)
        assertEquals("2 more running", WatchCopy.countsLine(working))
        assertEquals("", WatchCopy.countsLine(working.copy(runningCount = 1)))
        assertEquals("Sessions ended. 3 answered, 1 PR merged.", WatchCopy.endSummary(3, 1))
        assertEquals("Sessions ended. 0 answered, 2 PRs merged.", WatchCopy.endSummary(0, 2))
        assertEquals("optio://needs-you", WatchCopy.url(GlanceWatchState.QUIET))
        assertEquals("optio://local/t1?compose=1", WatchCopy.url(waiting))
    }

    @Test
    fun taskActionsAndReplyTitle() {
        val attention = row(kind = WatchItemKind.TASK, state = "needs_attention", prUrl = "https://x/pull/1")
        assertTrue(WatchCopy.isAttentionTask(attention))
        assertFalse(WatchCopy.isFailedTask(attention))
        assertEquals("https://x/pull/1", WatchCopy.prUrl(attention))
        assertTrue(WatchCopy.isFailedTask(row(kind = WatchItemKind.TASK, state = "failed")))
        assertNull(WatchCopy.prUrl(row(prUrl = "https://x/pull/2")), "only tasks open a PR")
        assertEquals("Reply…", WatchCopy.replyTitle(row()))
        assertEquals("Message…", WatchCopy.replyTitle(row(kind = WatchItemKind.AGENT, state = "failed")))
    }

    // endregion

    @Test
    fun rowVocabulary() {
        assertEquals("web", row(title = "claude-code · web").rowName)
        assertEquals("claude-code", row(title = "claude-code · web").rowAgent)
        assertEquals("fix/login", row(kind = WatchItemKind.TASK, title = "Fix login", mono = "fix/login").rowName)
        assertEquals("Deploy", row(title = "Deploy").rowName)
        assertNull(row(title = "Deploy").rowAgent)
        assertEquals("Allow?", row(reason = "Waiting on a permission").badge?.word)
        assertEquals("Reply", row(reason = "Claude stopped — reply to continue").badge?.word)
        assertEquals("Quiet", row(reason = "Gone quiet").badge?.word)
        assertEquals("Conflict", row(kind = WatchItemKind.TASK, state = "needs_attention", reason = "Merge conflict — resume?").badge?.word)
        assertEquals(GlanceStatus.FAILED, row(state = "failed").badge?.status)
        assertEquals("CI", row(kind = WatchItemKind.TASK, state = "pr_opened", reason = "PR #1 · CI failing").badge?.word)
        assertEquals("PR", row(kind = WatchItemKind.TASK, state = "pr_opened", reason = "PR #1 open · CI running").badge?.word)
        assertNull(row(state = "working").badge, "just working → no badge")
        assertTrue(row(state = "needs_you").waitsOnYou)
        assertFalse(row(state = "working").waitsOnYou)
        assertEquals(GlanceStatus.WORKING, GlanceStatus.forState("queued"))
        assertEquals(GlanceStatus.DEAD, GlanceStatus.forState("mystery"))
    }

    private fun row(
        kind: WatchItemKind = WatchItemKind.LOCAL,
        title: String = "claude-code · web",
        mono: String = "web",
        state: String = "needs_you",
        reason: String? = "Waiting on a permission",
        statusLabel: String? = null,
        prUrl: String? = null,
    ) = GlanceItem(
        kind = kind,
        id = "t1",
        title = title,
        mono = mono,
        reason = reason,
        since = now,
        state = state,
        link = "optio://local/t1?compose=1",
        prUrl = prUrl,
        statusLabel = statusLabel,
    )
}
