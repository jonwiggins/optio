package dev.optio.feature.glance

import android.app.Notification
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.glance.GlanceStore
import dev.optio.core.glance.GlanceWatchState
import dev.optio.core.glance.WatchSources
import dev.optio.core.model.AndroidPushWatchEvent
import dev.optio.core.model.WatchPhase
import dev.optio.core.testing.FakeOptioServer
import dev.optio.feature.glance.GlanceTestEnv.item
import dev.optio.feature.glance.GlanceTestEnv.text
import dev.optio.feature.glance.GlanceTestEnv.title
import dev.optio.feature.glance.notifications.AlertNotifier
import dev.optio.feature.glance.notifications.NeedsYouNotifier
import dev.optio.feature.glance.notifications.NotifiedStore
import dev.optio.feature.glance.watch.WatchManager
import dev.optio.feature.glance.watch.WatchManager.FrameResult
import dev.optio.feature.glance.watch.WatchNotifier
import dev.optio.feature.glance.watch.WatchStore
import java.time.Instant
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import org.junit.runner.RunWith

/**
 * The Watch (iOS `LiveActivityManager`): checks of the servers start, update and end it; FCM frames
 * follow the as-built rules (update-as-start, ignore an unknown end, drop stale frames).
 */
@RunWith(AndroidJUnit4::class)
class WatchManagerTest {
    private val context = GlanceTestEnv.context()
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val server = FakeOptioServer().start()
    private var now = GlanceTestEnv.now
    private val sources = WatchSources(InMemoryPreferences(), scope)
    private val glanceStore = GlanceStore.inMemory()
    private val watchStore = WatchStore.inMemory()
    private val alerts = AlertNotifier(context)
    private val needsYou = NeedsYouNotifier(alerts, NotifiedStore.inMemory())

    private fun manager(clients: List<dev.optio.core.data.ServerClient> = listOf(GlanceTestEnv.client(server))) =
        WatchManager(
            scope = scope,
            host = WatchManager.fixedHost(clients),
            sources = sources,
            glanceStore = glanceStore,
            store = watchStore,
            notifier = WatchNotifier(context),
            needsYou = needsYou,
            clock = { now },
            serverTimeout = 5.seconds,
        )

    @AfterTest
    fun tearDown() {
        scope.cancel()
        server.close()
    }

    private fun watch(): Notification? = GlanceTestEnv.notification(context, null, WatchNotifier.WATCH_ID)

    private fun alert(tag: String): Notification? = GlanceTestEnv.notification(context, tag, AlertNotifier.ALERT_ID)

    private fun serve(vararg terminals: String) {
        server.json("/api/local/hosts", """{"hosts":[{"id":"h1","name":"MacBook","state":"online"}]}""")
        server.json("/api/local/terminals", """{"terminals":[${terminals.joinToString(",")}]}""")
        server.json("/api/glance/watch", """{"phase":"working","others":[],"needsYouCount":0,"runningCount":0,"waitingCount":1,"recurringCount":2,"agentCount":3,"asOf":0}""")
    }

    private fun terminal(
        id: String,
        attention: String,
        reason: String? = null,
        updated: Instant = now.minusSeconds(120),
    ) = """{"id":"$id","hostId":"h1","title":"claude-code · $id","dir":"/Users/me/repos/$id","state":"running",
           "attentionState":"$attention","attentionReason":${reason?.let { "\"$it\"" } ?: "null"},"spawnedBy":"manual",
           "spec":{"kind":"agent","agent":"claude-code","mode":"interactive"},"preview":"Allow?","updatedAt":"$updated"}"""

    // region Checks of the servers

    @Test
    fun aCheckShowsTheWatchAndAlertsOncePerEpisode(): Unit =
        runBlocking {
            serve(terminal("web", "needs_you", "notification"), terminal("api", "working"))
            val m = manager()
            m.reconcile()
            val w = assertNotNull(watch(), "something needs you → the Watch starts")
            assertEquals("1 session needs you", title(w))
            assertEquals("claude-code · web · needs you · Waiting on a permission", text(w))
            assertTrue(m.showing.value)
            assertEquals(2, m.display.value?.recurringCount)
            val a = assertNotNull(alert("local-web"), "the on-device baseline alerts")
            assertEquals("Needs you · web", title(a))
            assertEquals("Waiting on a permission · Allow?", text(a))
            // Cached for widgets.
            assertEquals(listOf("web"), glanceStore.cachedSnapshot("srv-1")!!.needsYou.map { it.id })

            // Same episode: no second alert.
            GlanceTestEnv.manager(context).cancelAll()
            m.reconcile()
            assertNull(alert("local-web"), "already alerted")
        }

    @Test
    fun quietForTwoMinutesEndsTheWatchWithASummary(): Unit =
        runBlocking {
            serve(terminal("web", "needs_you", "stop"))
            val m = manager()
            m.reconcile()
            assertTrue(m.showing.value)
            serve()
            m.reconcile()
            assertTrue(m.showing.value, "quiet, but not for 2 minutes yet")
            assertNotNull(watch(), "still up")
            now = now.plusSeconds(121)
            m.reconcile()
            assertFalse(m.showing.value)
            val ended = assertNotNull(watch())
            assertEquals("Sessions ended", title(ended))
            assertEquals("Sessions ended. 1 answered, 0 PRs merged.", text(ended), "the needs-you item left while it showed")
            assertEquals(0, ended.flags and Notification.FLAG_ONGOING_EVENT)
        }

    @Test
    fun ninetySecondsOfFailureTurnsItOffline(): Unit =
        runBlocking {
            serve(terminal("web", "working"))
            val m = manager()
            m.reconcile()
            assertEquals(WatchPhase.WORKING, m.display.value?.phase)
            server.error("GET", "/api/local/hosts", 503, "down")
            now = now.plusSeconds(30)
            m.reconcile()
            assertEquals(WatchPhase.WORKING, m.display.value?.phase, "under 90 s: keep the last frame")
            now = now.plusSeconds(90)
            m.reconcile()
            assertEquals(WatchPhase.OFFLINE, m.display.value?.phase)
            assertEquals("Machine unreachable", title(watch()!!))
            assertNotNull(glanceStore.unreachableSince("srv-1"), "widgets learn the server is unreachable")
        }

    @Test
    fun finishedFollowedTasksAreUnfollowedAndAgentTurnsJoin(): Unit =
        runBlocking {
            serve()
            server.json("/api/tasks/done", """{"task":{"id":"done","title":"Ship it","state":"completed"}}""")
            server.json("/api/persistent-agents/a1", """{"agent":{"id":"a1","name":"Vesper","slug":"vesper","state":"running","agentRuntime":"codex"}}""")
            sources.follow("done")
            sources.recordAgentSendNow("a1", now.minusSeconds(60))
            val m = manager()
            m.reconcile()
            assertEquals(emptySet(), sources.followed(), "completed everywhere → unfollowed")
            val head = assertNotNull(m.display.value?.head)
            assertEquals("Vesper", head.title)
            assertEquals("thinking", head.statusText)
            assertEquals("@vesper", head.mono)
            assertEquals("codex", head.whoValue)
            assertEquals("optio://agents/a1?compose=1&server=srv-1", head.link)
        }

    @Test
    fun signingOutEndsTheWatchAtOnce(): Unit =
        runBlocking {
            serve(terminal("web", "needs_you"))
            val m = manager()
            m.reconcile()
            assertNotNull(watch())
            val out = manager(clients = emptyList())
            out.reconcile()
            assertNull(watch())
        }

    // endregion

    // region Push frames

    private fun frame(
        phase: WatchPhase,
        asOf: Instant,
        headId: String? = "web",
        needs: Int = if (phase == WatchPhase.WAITING) 1 else 0,
        running: Int = 1,
    ) = GlanceWatchState(
        phase = phase,
        head = headId?.let { item(it, state = if (phase == WatchPhase.WAITING) "needs_you" else "working", server = null) },
        needsYouCount = needs,
        runningCount = running,
        asOf = asOf,
    ).toWire()

    @Test
    fun anUpdateForAWatchThatIsNotShowingStartsIt(): Unit =
        runBlocking {
            val m = manager()
            assertEquals(FrameResult.APPLIED, m.applyFrame("srv-1", AndroidPushWatchEvent.UPDATE, frame(WatchPhase.WAITING, now)))
            assertTrue(m.showing.value)
            assertEquals("1 session needs you", title(watch()!!))
            assertEquals("srv-1", m.display.value?.head?.serverId, "rows are tagged with the frame's server")
        }

    @Test
    fun anEndForAWatchThatIsNotShowingIsIgnored(): Unit =
        runBlocking {
            val m = manager()
            assertEquals(FrameResult.IGNORED_END, m.applyFrame("srv-1", AndroidPushWatchEvent.END, frame(WatchPhase.DONE, now, headId = null)))
            assertFalse(m.showing.value)
            assertNull(watch())
        }

    @Test
    fun framesOlderThanTheShownOneAreDropped(): Unit =
        runBlocking {
            val m = manager()
            m.applyFrame("srv-1", AndroidPushWatchEvent.START, frame(WatchPhase.WAITING, now))
            val stale = frame(WatchPhase.WORKING, now.minusSeconds(5))
            assertEquals(FrameResult.STALE, m.applyFrame("srv-1", AndroidPushWatchEvent.UPDATE, stale))
            assertEquals(WatchPhase.WAITING, m.display.value?.phase)
            assertEquals(FrameResult.APPLIED, m.applyFrame("srv-1", AndroidPushWatchEvent.UPDATE, frame(WatchPhase.WORKING, now.plusSeconds(1), headId = "api")))
            assertEquals("api", m.display.value?.head?.id)
        }

    @Test
    fun anEndWhileShowingEndsIt(): Unit =
        runBlocking {
            val m = manager()
            m.applyFrame("srv-1", AndroidPushWatchEvent.START, frame(WatchPhase.WORKING, now))
            assertTrue(m.showing.value)
            val done = GlanceWatchState(WatchPhase.DONE, summary = "Quiet.", asOf = now.plusSeconds(120)).toWire()
            assertEquals(FrameResult.ENDED, m.applyFrame("srv-1", AndroidPushWatchEvent.END, done))
            assertFalse(m.showing.value)
            assertEquals("Quiet.", text(watch()!!), "the server's summary")
        }

    @Test
    fun framesFromTwoServersMergeAndSurviveARestart(): Unit =
        runBlocking {
            val m = manager()
            m.applyFrame("srv-1", AndroidPushWatchEvent.START, frame(WatchPhase.WORKING, now, headId = "api", running = 2))
            m.applyFrame("srv-2", AndroidPushWatchEvent.START, frame(WatchPhase.WAITING, now, headId = "web"))
            assertEquals(WatchPhase.WAITING, m.display.value?.phase)
            assertEquals("web", m.display.value?.head?.id)
            assertEquals(3, m.display.value?.runningCount)
            // A new process (FCM starts one) remembers the board and the last asOf per server.
            val next = manager()
            assertEquals(FrameResult.STALE, next.applyFrame("srv-2", AndroidPushWatchEvent.UPDATE, frame(WatchPhase.WORKING, now.minusSeconds(1))))
            assertEquals(FrameResult.APPLIED, next.applyFrame("srv-2", AndroidPushWatchEvent.END, GlanceWatchState(WatchPhase.DONE, asOf = now.plusSeconds(1)).toWire()))
            assertEquals(WatchPhase.WORKING, next.display.value?.phase, "srv-1 still runs")
            assertEquals("api", next.display.value?.head?.id)
            assertTrue(watchStore.load().showing)
        }

    // endregion

    @Test
    fun dismissedWatchStaysAwayUntilItChanges(): Unit =
        runBlocking {
            val m = manager()
            m.applyFrame("srv-1", AndroidPushWatchEvent.START, frame(WatchPhase.WAITING, now))
            m.userDismissed()
            GlanceTestEnv.manager(context).cancelAll()
            m.applyFrame("srv-1", AndroidPushWatchEvent.UPDATE, frame(WatchPhase.WAITING, now.plusSeconds(1)))
            assertNull(watch(), "same head, same count: stays dismissed")
            m.applyFrame("srv-1", AndroidPushWatchEvent.UPDATE, frame(WatchPhase.WAITING, now.plusSeconds(2), needs = 2))
            assertNotNull(watch(), "something new needs you: back")
            assertTrue(m.showing.first())
        }
}
