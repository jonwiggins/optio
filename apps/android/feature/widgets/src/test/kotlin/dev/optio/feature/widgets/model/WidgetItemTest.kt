package dev.optio.feature.widgets.model

import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchThen
import dev.optio.core.model.WatchWhere
import dev.optio.core.model.WatchWhereTarget
import dev.optio.core.ui.theme.StatusKind
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Test

/**
 * The session-row vocabulary: the chip fallbacks for rows from older servers (iOS
 * `WatchSessionsTests.testLegacyFrameDecodesWithFallbacks`) and the widget's one-symbol-one-word
 * badges (iOS `GlanceStyle.RowBadge`).
 */
class WidgetItemTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")

    private fun item(
        kind: WatchItemKind,
        title: String = "t",
        mono: String = "m",
        state: String = "running",
        reason: String? = null,
    ) = WidgetItem(kind = kind, id = "i", title = title, mono = mono, reason = reason, since = now, state = state, link = "optio://x")

    @Test
    fun localTerminalFallbacks() {
        val local = item(WatchItemKind.LOCAL, title = "claude-code · optio", mono = "repos/optio/apps/web", state = "needs_you")
        assertEquals("now", local.whenLabel)
        assertEquals(WatchWhere(WatchWhereTarget.MACHINE, "repos/optio/apps/web"), local.whereValue)
        assertEquals("claude-code", local.whoValue, "agent named in the default terminal title")
        assertEquals(WatchThen.WAITS_FOR_ME, local.thenValue)
        assertEquals("needs you", local.statusText)
    }

    @Test
    fun taskAndAgentFallbacks() {
        val task = item(WatchItemKind.TASK, title = "docs", mono = "docs/readme", state = "pr_opened")
        assertEquals(WatchWhere(WatchWhereTarget.POD, "docs/readme"), task.whereValue)
        assertEquals("claude-code", task.whoValue)
        assertEquals(WatchThen.EXITS, task.thenValue)
        assertEquals("PR open", task.statusText)

        val agent = item(WatchItemKind.AGENT, title = "Vesper", mono = "@vesper")
        assertEquals("messages", agent.whenLabel)
        assertEquals(ChipIcon.CPU, agent.whenIcon)
        assertEquals(WatchThen.WAITS_FOR_MESSAGES, agent.thenValue)
    }

    @Test
    fun plainShellIsATerminal() {
        val shell = item(WatchItemKind.LOCAL, title = "zsh", mono = "notes", state = "needs_you")
        assertEquals("terminal", shell.whoValue)
        assertTrue(shell.whoIsTerminal)
        assertEquals(ChipIcon.TERMINAL, shell.whoIcon)
    }

    @Test
    fun wireValuesWinOverFallbacks() {
        val wired =
            item(WatchItemKind.TASK).copy(
                `when` = "on a trigger", where = WatchWhere(WatchWhereTarget.POD, "acme/web"), who = "codex", then = WatchThen.EXITS, statusLabel = "running",
            )
        assertEquals("on a trigger", wired.whenLabel)
        assertEquals(ChipIcon.CLOCK, wired.whenIcon)
        assertEquals("acme/web", wired.whereValue.detail)
        assertEquals("codex", wired.whoValue)
        assertEquals(ChipIcon.BOLT, wired.whoIcon)
        assertEquals("running", wired.statusText)
    }

    @Test
    fun rowNames() {
        assertEquals("web", item(WatchItemKind.LOCAL, title = "claude-code · web", mono = "optio/apps/web").rowName, "leaf of a default title")
        assertEquals("claude-code", item(WatchItemKind.LOCAL, title = "claude-code · web").rowAgent)
        assertEquals("Fix the flaky test", item(WatchItemKind.LOCAL, title = "Fix the flaky test").rowName, "user titles pass through")
        assertNull(item(WatchItemKind.LOCAL, title = "Fix the flaky test").rowAgent)
        assertEquals("fix/login", item(WatchItemKind.TASK, title = "fix: login", mono = "fix/login").rowName, "tasks show their branch")
        assertEquals("Vesper", item(WatchItemKind.AGENT, title = "Vesper", mono = "@vesper").rowName)
    }

    @Test
    fun waitsOnYouMeansNeedsInputOrFailed() {
        assertTrue(item(WatchItemKind.LOCAL, state = "needs_you").waitsOnYou)
        assertTrue(item(WatchItemKind.TASK, state = "needs_attention").waitsOnYou)
        assertTrue(item(WatchItemKind.AGENT, state = "failed").waitsOnYou)
        assertFalse(item(WatchItemKind.TASK, state = "pr_opened").waitsOnYou)
        assertFalse(item(WatchItemKind.LOCAL, state = "working").waitsOnYou)
    }

    @Test
    fun snoozeWindow() {
        val snoozed = item(WatchItemKind.LOCAL).copy(snoozedUntil = now.plusSeconds(60))
        assertTrue(snoozed.isSnoozed(now))
        assertFalse(snoozed.isSnoozed(now.plusSeconds(61)))
        assertFalse(item(WatchItemKind.LOCAL).isSnoozed(now))
    }

    @Test
    fun badgesForNeedsYouReasons() {
        fun word(reason: String?) = RowBadge.of("needs_you", reason)
        assertEquals(RowBadge(RowBadge.Symbol.HAND, "Allow?", StatusKind.NEEDS_INPUT), word("Waiting on a permission"))
        assertEquals("Reply", word("Claude stopped — reply to continue")?.word)
        assertEquals("Reply", word("waiting for you")?.word)
        assertEquals("Quiet", word("Gone quiet")?.word)
        assertEquals("Bell", word("bell")?.word)
        assertEquals("Review", word("Finished — review")?.word)
        assertEquals(RowBadge(RowBadge.Symbol.ALERT_BUBBLE, "Needs you", StatusKind.NEEDS_INPUT), word(null))
    }

    @Test
    fun badgesForTaskStates() {
        assertEquals("Conflict", RowBadge.of("needs_attention", "Merge conflict — resume?")?.word)
        assertEquals("Stuck", RowBadge.of("needs_attention", null)?.word)
        assertEquals(RowBadge(RowBadge.Symbol.X_FILLED, "Failed", StatusKind.FAILED), RowBadge.of("failed", "boom"))
        assertEquals(RowBadge(RowBadge.Symbol.X_OUTLINE, "CI", StatusKind.FAILED), RowBadge.of("pr_opened", "CI failing"))
        assertEquals("Approved", RowBadge.of("pr_opened", "PR #1 · CI passed · review approved")?.word)
        assertEquals(RowBadge(RowBadge.Symbol.CHECK_OUTLINE, "Review", StatusKind.COMPLETED), RowBadge.of("pr_opened", "CI passed"))
        assertEquals(RowBadge(RowBadge.Symbol.PULL, "PR", StatusKind.WORKING), RowBadge.of("pr_opened", null))
        assertEquals(RowBadge(RowBadge.Symbol.CLOCK, "Queued", StatusKind.DEAD), RowBadge.of("queued", null))
        assertEquals("Starting", RowBadge.of("provisioning", null)?.word)
        assertNull(RowBadge.of("running", null), "just working: no badge")
        assertNull(RowBadge.of("working", null))
    }

    @Test
    fun statusWordFallsBackToTheSessionLabel() {
        assertEquals("Allow?", item(WatchItemKind.LOCAL, state = "needs_you", reason = "permission").statusWord)
        assertEquals("working", item(WatchItemKind.LOCAL, state = "working").statusWord)
        assertEquals(StatusKind.WORKING, item(WatchItemKind.LOCAL, state = "working").statusKind)
        assertEquals(StatusKind.COMPLETED, item(WatchItemKind.TASK, state = "pr_opened", reason = "CI passed").statusKind, "the badge's colour wins")
    }

    @Test
    fun shortDirAndRepo() {
        assertEquals("~/repos/optio/apps/web", SessionText.shortDir("/Users/jon/repos/optio/apps/web"))
        assertEquals("~/x", SessionText.shortDir("/home/dev/x"))
        assertEquals("~", SessionText.shortDir("/Users/jon"))
        assertEquals("/srv/app", SessionText.shortDir("/srv/app"))
        assertEquals("acme/web", SessionText.shortRepo("https://github.com/acme/web.git"))
        assertEquals("g/sub/repo", SessionText.shortRepo("https://gitlab.example.com/g/sub/repo"))
        assertNull(SessionText.shortRepo(null))
        assertEquals("needs attention", SessionText.taskStatusLabel("needs_attention"))
        assertEquals("PR open", SessionText.taskStatusLabel("pr_opened"))
    }
}
