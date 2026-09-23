package dev.optio.feature.glance

import android.app.Notification
import android.app.NotificationManager
import androidx.core.app.NotificationCompat
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.NotificationSubject
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import dev.optio.feature.glance.GlanceTestEnv.actions
import dev.optio.feature.glance.GlanceTestEnv.bigText
import dev.optio.feature.glance.GlanceTestEnv.item
import dev.optio.feature.glance.GlanceTestEnv.remoteInputs
import dev.optio.feature.glance.GlanceTestEnv.text
import dev.optio.feature.glance.GlanceTestEnv.title
import dev.optio.feature.glance.GlanceTestEnv.url
import dev.optio.feature.glance.notifications.AlertNotifier
import dev.optio.feature.glance.notifications.AlertSpec
import dev.optio.feature.glance.notifications.DeepLinkIntents
import dev.optio.feature.glance.notifications.NotificationCategory
import dev.optio.feature.glance.notifications.OptioChannel
import dev.optio.feature.glance.watch.WatchNotifier
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/** Channels, alerts (actions, RemoteInput, tags, taps) and the Watch notification, built for real. */
@RunWith(AndroidJUnit4::class)
class NotificationBuildingTest {
    private val context = GlanceTestEnv.context()
    private val alerts = AlertNotifier(context)
    private val watch = WatchNotifier(context)

    // region Channels

    @Test
    fun oneChannelPerCategoryPlusTheWatch() {
        val manager = context.getSystemService(NotificationManager::class.java)
        val channels = manager.notificationChannels.associateBy { it.id }
        assertEquals(OptioChannel.entries.map { it.id }.toSet(), channels.keys)
        assertEquals(NotificationManager.IMPORTANCE_HIGH, channels.getValue("optio.needs_you").importance)
        assertEquals(NotificationManager.IMPORTANCE_LOW, channels.getValue("optio.local_exit").importance, "local exit is silent")
        assertEquals(NotificationManager.IMPORTANCE_LOW, channels.getValue("optio.watch").importance, "the Watch never alerts")
        assertEquals("Needs you", channels.getValue("optio.needs_you").name)
        // Every category lands on its own channel (TEST shares "Other").
        assertEquals(
            listOf("optio.needs_you", "optio.local_exit", "optio.host_offline", "optio.task_attention", "optio.pr_opened", "optio.agent_reply", "optio.agent_failed", "optio.other"),
            NotificationCategory.entries.map { it.channel.id },
        )
    }

    // endregion

    // region Alerts

    private fun needsYou(
        serverId: String? = "srv-1",
        audible: Boolean = true,
    ) = AlertSpec(
        category = NotificationCategory.LOCAL_NEEDS_YOU,
        title = "Needs you · web",
        subtitle = "claude-code · web",
        body = "Waiting on a permission · Allow Bash(rm -rf)?",
        url = "optio://local/t1?compose=1",
        kind = "local",
        id = "t1",
        threadId = "t1",
        audible = audible,
        timeSensitive = true,
        collapseId = "local-t1",
        serverId = serverId,
    )

    @Test
    fun needsYouAlertHasReplyWithRemoteInputAndLater() {
        assertTrue(alerts.post(needsYou()))
        val n = assertNotNull(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID), "the collapse id is the tag")
        assertEquals("optio.needs_you", n.channelId)
        assertEquals("Needs you · web", title(n))
        assertEquals("Waiting on a permission · Allow Bash(rm -rf)?", text(n))
        assertEquals("claude-code · web", n.extras.getCharSequence(NotificationCompat.EXTRA_SUB_TEXT)?.toString())
        assertEquals("t1", n.group, "the thread id groups a chatty terminal")
        assertEquals(listOf("Reply", "Later"), actions(n))
        assertEquals(listOf(true, false), n.actions.map { it.isAuthenticationRequired }, "typing into a terminal needs an unlocked phone; Later does not")
        val input = remoteInputs(n).single()
        assertEquals(AlertNotifier.REPLY_KEY, input.resultKey)
        assertEquals("Your reply", input.label)
        assertEquals("optio://local/t1?compose=1&server=srv-1", url(n.contentIntent), "the tap opens the link on the alert's server")
        assertEquals(NotificationCompat.CATEGORY_REMINDER, n.category)
        assertEquals(Notification.VISIBILITY_PRIVATE, n.visibility)
        assertNotNull(n.publicVersion, "a redacted lock-screen version")
        assertFalse(NotificationCompat.isGroupSummary(n))
        // A newer alert for the same terminal replaces it (same tag).
        alerts.post(needsYou().copy(body = "Claude stopped — reply to continue"))
        assertEquals(1, GlanceTestEnv.all(context).size)
        assertEquals("Claude stopped — reply to continue", text(GlanceTestEnv.notification(context, "local-t1", AlertNotifier.ALERT_ID)!!))
    }

    @Test
    fun actionsPerCategoryMatchIos() {
        fun spec(
            category: NotificationCategory,
            kind: String,
            prUrl: String? = null,
        ) = needsYou().copy(category = category, kind = kind, id = "x", collapseId = "c-${category.raw}", prUrl = prUrl, url = "optio://tasks/x")
        assertEquals(listOf("Open"), actions(alerts.build(spec(NotificationCategory.LOCAL_EXIT, "local"))))
        assertEquals(emptyList(), actions(alerts.build(spec(NotificationCategory.HOST_OFFLINE, "host"))))
        assertEquals(listOf("Resume", "Retry", "Open"), actions(alerts.build(spec(NotificationCategory.TASK_ATTENTION, "task"))))
        val pr = alerts.build(spec(NotificationCategory.TASK_PR_OPENED, "task", prUrl = "https://github.com/o/r/pull/1"))
        assertEquals(listOf("Open PR"), actions(pr))
        assertEquals("https://github.com/o/r/pull/1", url(pr.actions[0].actionIntent), "Open PR goes to the browser")
        val reply = alerts.build(spec(NotificationCategory.AGENT_REPLY, "agent"))
        assertEquals(listOf("Reply"), actions(reply))
        assertEquals(1, remoteInputs(reply).size)
        assertNotNull(NotificationCompat.MessagingStyle.extractMessagingStyleFromNotification(reply), "agent replies read as a conversation")
        assertEquals(listOf("Resume"), actions(alerts.build(spec(NotificationCategory.AGENT_FAILED, "agent"))))
        assertEquals(emptyList(), actions(alerts.build(spec(NotificationCategory.TEST, "test"))))
        assertEquals(NotificationCategory.TEST, NotificationCategory.of("SOMETHING_NEW"), "unknown categories post on Other")
    }

    @Test
    fun soundNoneAndForegroundRulesPostSilently() {
        assertTrue(silent(alerts.build(needsYou(audible = false), inForeground = false)), "sound: none")
        assertFalse(silent(alerts.build(needsYou(), inForeground = false)))
        assertFalse(silent(alerts.build(needsYou(), inForeground = true)), "needs-you still presents in the foreground")
        val exit = needsYou().copy(category = NotificationCategory.LOCAL_EXIT)
        assertTrue(silent(alerts.build(exit, inForeground = true)), "LOCAL_EXIT does not present in the foreground")
        NotificationSubject.set("local", "t1")
        try {
            assertTrue(silent(alerts.build(needsYou(), inForeground = true)), "the user is looking at it")
        } finally {
            NotificationSubject.clear("local", "t1")
        }
    }

    @Test
    fun alertsNeedThePermission() {
        val denied = GlanceTestEnv.context(grant = false)
        assertFalse(AlertNotifier(denied).post(needsYou()))
        assertNull(GlanceTestEnv.notification(denied, "local-t1", AlertNotifier.ALERT_ID))
        GlanceTestEnv.context(grant = true)
    }

    /** NotificationCompat.setSilent: only a (never posted) group summary may alert, so this one does not. */
    private fun silent(n: Notification): Boolean = NotificationCompat.getGroupAlertBehavior(n) == NotificationCompat.GROUP_ALERT_SUMMARY

    // endregion

    // region Deep links

    @Test
    fun tapLinksCarryTheServerAndFallBackPerKind() {
        assertEquals("optio://local/t1?compose=1&server=s2", DeepLinkIntents.withServer("optio://local/t1?compose=1", "s2"))
        assertEquals("optio://local/t1?server=s1", DeepLinkIntents.withServer("optio://local/t1?server=s1", "s2"), "an explicit server wins")
        assertEquals("optio://local/t1", DeepLinkIntents.withServer("optio://local/t1", null))
        assertEquals("optio://section/machines?server=s1", DeepLinkIntents.tapUrl("optio://local", "host", "h1", "s1"), "host-offline's link is not routable")
        assertEquals("optio://tasks/k", DeepLinkIntents.tapUrl(null, "task", "k", null))
        assertEquals("optio://agents/a", DeepLinkIntents.fallbackUrl("agent", "a"))
        assertEquals("optio://section/more", DeepLinkIntents.tapUrl("optio://settings", "test", "test", null), "the test push opens More")
        assertNull(DeepLinkIntents.fallbackUrl("sticker", "x"))
        val intent = DeepLinkIntents.view(context, "optio://needs-you")
        assertEquals(android.content.Intent.ACTION_VIEW, intent.action)
        assertEquals(context.packageName, intent.`package`)
    }

    // endregion

    // region The Watch

    @Test
    fun waitingWatchIsAnOngoingPromotableSessionRow() {
        val head = item("t1", preview = "Allow Bash(pnpm test)? (y/n)")
        val state =
            GlanceWatchState(
                phase = WatchPhase.WAITING,
                head = head,
                others = listOf(item("t2", minutesAgo = 1)),
                needsYouCount = 3,
                runningCount = 2,
                asOf = GlanceTestEnv.now,
            )
        val n = watch.build(state, multiServer = true, promoted = false)
        assertEquals("optio.watch", n.channelId)
        assertEquals("3 sessions need you", title(n))
        assertEquals("claude-code · web · needs you · Waiting on a permission", text(n))
        val body = bigText(n)!!
        assertTrue(body.startsWith("claude-code · web  ·  SRV-1"), body)
        assertTrue("“Allow Bash(pnpm test)? (y/n)”" in body, "the private version has the preview")
        assertTrue("now · MacBook Pro · web · Claude Code · waits for me" in body, body)
        assertTrue("2 more need you · 2 running" in body, body)
        assertTrue(n.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertTrue(n.extras.getBoolean(NotificationCompat.EXTRA_REQUEST_PROMOTED_ONGOING), "asks to be a Live Update")
        assertEquals("web +2", n.extras.getString(NotificationCompat.EXTRA_SHORT_CRITICAL_TEXT) ?: WatchNotifier.chipText(state))
        assertTrue(n.extras.getBoolean(NotificationCompat.EXTRA_SHOW_CHRONOMETER), "the since-timer")
        assertEquals(head.since.toEpochMilli(), n.`when`)
        assertEquals(WatchNotifier.tint(WatchPhase.WAITING), n.color)
        assertEquals(listOf("Reply", "Later", "Open"), actions(n))
        assertEquals(1, remoteInputs(n).size)
        assertEquals("optio://local/t1?compose=1&server=srv-1", url(n.contentIntent))
        val public = assertNotNull(n.publicVersion)
        assertFalse(bigText(public)!!.contains("Allow Bash"), "the lock screen never shows the prompt")
        assertTrue(n.extras.getBoolean(NotificationCompat.EXTRA_SHOW_WHEN))
        assertNull(n.extras.getCharSequence(NotificationCompat.EXTRA_SUB_TEXT), "the headline says it all")

        // Promoted (a Live Update): its template drops inline replies, so Reply opens the composer.
        val promoted = watch.build(state, multiServer = true, promoted = true)
        assertEquals(listOf("Reply", "Later"), actions(promoted))
        assertEquals(emptyList(), remoteInputs(promoted))
        assertEquals("optio://local/t1?compose=1&server=srv-1", url(promoted.actions[0].actionIntent))
    }

    @Test
    fun watchActionsFollowTheHead() {
        fun actionsFor(
            phase: WatchPhase,
            head: dev.optio.core.glance.GlanceItem,
        ) = actions(watch.build(GlanceWatchState(phase, head = head, needsYouCount = 1, runningCount = 1, asOf = GlanceTestEnv.now), multiServer = false, promoted = false))
        val attention = item("k", kind = WatchItemKind.TASK, state = "needs_attention", prUrl = "https://x/pull/1")
        assertEquals(listOf("Resume", "Reply", "Open PR"), actionsFor(WatchPhase.WAITING, attention))
        val failed = item("k2", kind = WatchItemKind.TASK, state = "failed")
        assertEquals(listOf("Retry", "Reply", "Later"), actionsFor(WatchPhase.WAITING, failed))
        val agent = item("a", kind = WatchItemKind.AGENT, state = "failed", title = "Vesper", mono = "@vesper")
        assertEquals(listOf("Message", "Later", "Open"), actionsFor(WatchPhase.WAITING, agent))
        val pr = item("p", kind = WatchItemKind.TASK, state = "pr_opened", prUrl = "https://x/pull/2")
        assertEquals(listOf("Open PR"), actionsFor(WatchPhase.WORKING, pr), "working: only Open PR")
        assertEquals(emptyList(), actionsFor(WatchPhase.WORKING, item("r", state = "working")), "no filler")
    }

    @Test
    fun endedAndKeepWatchingVariants() {
        val ended = watch.buildEnded("Sessions ended. 3 answered, 1 PR merged.")
        assertEquals("Sessions ended", title(ended))
        assertEquals("Sessions ended. 3 answered, 1 PR merged.", text(ended))
        assertEquals(0, ended.flags and Notification.FLAG_ONGOING_EVENT)
        assertEquals(WatchNotifier.DISMISS_AFTER_MS, ended.timeoutAfter)
        assertFalse(ended.extras.getBoolean(NotificationCompat.EXTRA_REQUEST_PROMOTED_ONGOING))

        val keep = watch.buildKeepWatching("Nothing needs you · watching MacBook")
        assertEquals("Keeping watch", title(keep))
        assertTrue(keep.flags and Notification.FLAG_ONGOING_EVENT != 0)
        assertEquals(listOf("Stop watching"), actions(keep))

        val offline = watch.build(GlanceWatchState(WatchPhase.OFFLINE, offlineSince = GlanceTestEnv.now, asOf = GlanceTestEnv.now), multiServer = false)
        assertEquals("Machine unreachable", title(offline))
        assertTrue(text(offline)!!.startsWith("Machine unreachable since"))
        assertEquals("offline", WatchNotifier.chipText(GlanceWatchState(WatchPhase.OFFLINE, head = item("x"), asOf = GlanceTestEnv.now)))
        // Android drops status-chip text past ~7 characters (seen on an API 37 emulator): cut the name.
        assertEquals("Sec… +1", WatchNotifier.fitChip("Second bell", "+1"))
        assertEquals("Second…", WatchNotifier.fitChip("Second bell", ""))
        assertEquals("web +12", WatchNotifier.fitChip("web", "+12"))
        assertEquals("w… +123", WatchNotifier.fitChip("web", "+123"))
    }

    @Test
    fun postedWatchUsesItsOwnId() {
        val state = GlanceWatchState(WatchPhase.WORKING, head = item("r", state = "working"), runningCount = 1, asOf = GlanceTestEnv.now)
        assertTrue(watch.post(watch.build(state, multiServer = false)))
        assertNotNull(GlanceTestEnv.notification(context, null, WatchNotifier.WATCH_ID))
        watch.cancel()
        assertNull(GlanceTestEnv.notification(context, null, WatchNotifier.WATCH_ID))
        assertEquals("Nothing needs you · 1 running", title(watch.build(state, multiServer = false)))
        assertEquals("web", WatchNotifier.chipText(state))
        assertEquals(0, shadowOf(GlanceTestEnv.manager(context)).size())
    }

    // endregion
}
