package dev.optio.core.glance

import dev.optio.core.data.InMemoryPreferences
import dev.optio.core.model.WatchItemKind
import dev.optio.core.model.WatchPhase
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest

/** Watch-state merging across servers, the snapshot's Watch derivation, the cache and the watch sources. */
class GlanceStateTest {
    private val now = Instant.parse("2026-09-22T16:40:00Z")

    private fun item(
        id: String,
        minutesAgo: Long,
        state: String = "needs_you",
        server: String = "s1",
        snoozedUntil: Instant? = null,
        kind: WatchItemKind = WatchItemKind.LOCAL,
    ) = GlanceItem(
        kind = kind,
        id = id,
        title = "claude-code · $id",
        mono = id,
        since = now.minusSeconds(minutesAgo * 60),
        state = state,
        link = "optio://local/$id?compose=1&server=$server",
        snoozedUntil = snoozedUntil,
        serverId = server,
        serverName = server.uppercase(),
    )

    // region NeedsYouSnapshot.watchState

    @Test
    fun oldestUnsnoozedLeadsAndTwoMoreAreListed() {
        val snap =
            NeedsYouSnapshot(
                needsYou =
                    listOf(
                        item("new", 1),
                        item("oldest", 30, snoozedUntil = now.plusSeconds(600)),
                        item("old", 20),
                        item("mid", 10),
                    ),
                running = listOf(item("r1", 50, "working"), item("r2", 5, "working")),
                hostsOnline = 1,
                hostsTotal = 1,
                asOf = now,
            )
        val state = snap.watchState()
        assertEquals(WatchPhase.WAITING, state.phase)
        assertEquals("old", state.head?.id, "a snoozed item drops behind every unsnoozed one")
        assertEquals(listOf("mid", "new"), state.others.map { it.id })
        assertEquals(4, state.needsYouCount)
        assertEquals(2, state.runningCount)
    }

    @Test
    fun workingShowsTheNewestRunningItemAndOfflineWhenEveryHostIsDown() {
        val running = listOf(item("r1", 50, "working"), item("r2", 5, "working"))
        val working = NeedsYouSnapshot(running = running, hostsOnline = 1, hostsTotal = 2, asOf = now).watchState()
        assertEquals(WatchPhase.WORKING, working.phase)
        assertEquals("r2", working.head?.id)
        assertTrue(working.hasWork)

        val offline = NeedsYouSnapshot(needsYou = listOf(item("n", 3)), running = running, hostsOnline = 0, hostsTotal = 2, asOf = now).watchState()
        assertEquals(WatchPhase.OFFLINE, offline.phase)
        assertEquals(now, offline.offlineSince)
        assertEquals("n", offline.head?.id)
        assertFalse(offline.hasWork)

        val quiet = NeedsYouSnapshot(hostsOnline = 1, hostsTotal = 1, asOf = now).watchState()
        assertEquals(WatchPhase.WORKING, quiet.phase)
        assertNull(quiet.head)
        assertFalse(quiet.hasWork, "nothing running and nothing waiting → no Watch")
    }

    // endregion

    // region Merging per-server frames

    @Test
    fun mergeKeepsTheGlobalOldestNeedsYouAndSumsCounts() {
        val a =
            NeedsYouSnapshot(
                needsYou = listOf(item("a1", 5, server = "a"), item("a2", 40, server = "a")),
                running = listOf(item("ar", 2, "working", server = "a")),
                hostsOnline = 1,
                hostsTotal = 1,
                counts = SessionTileCounts(1, 2, 3),
                asOf = now,
            ).watchState()
        val b =
            NeedsYouSnapshot(
                needsYou = listOf(item("b1", 20, server = "b")),
                running = listOf(item("br", 1, "working", server = "b"), item("br2", 9, "working", server = "b")),
                hostsOnline = 1,
                hostsTotal = 1,
                asOf = now.plusSeconds(5),
            ).watchState()
        val merged = GlanceWatchState.merge(listOf(a, b), now)
        assertEquals(WatchPhase.WAITING, merged.phase)
        assertEquals("a2", merged.head?.id)
        assertEquals(listOf("b1", "a1"), merged.others.map { it.id })
        assertEquals(3, merged.needsYouCount)
        assertEquals(3, merged.runningCount)
        assertEquals(1, merged.waitingCount, "a tile from one server survives; the other adds nothing")
        assertEquals(now.plusSeconds(5), merged.asOf)
        assertEquals("b", merged.others.first().serverId)
    }

    @Test
    fun mergeOfWorkingAndQuietFramesAndAllDone() {
        val working = GlanceWatchState(WatchPhase.WORKING, head = item("r", 3, "working"), runningCount = 2, asOf = now)
        val quiet = GlanceWatchState.QUIET.copy(asOf = now)
        val merged = GlanceWatchState.merge(listOf(quiet, working), now)
        assertEquals(WatchPhase.WORKING, merged.phase)
        assertEquals("r", merged.head?.id)
        assertEquals(2, merged.runningCount)

        val done = GlanceWatchState(WatchPhase.DONE, summary = "Quiet.", asOf = now)
        val allDone = GlanceWatchState.merge(listOf(done, done.copy(summary = null)), now)
        assertEquals(WatchPhase.DONE, allDone.phase)
        assertEquals("Quiet.", allDone.summary)

        val offline = GlanceWatchState(WatchPhase.OFFLINE, head = item("x", 9), needsYouCount = 1, offlineSince = now.minusSeconds(300), asOf = now)
        val onlyOffline = GlanceWatchState.merge(listOf(offline, quiet), now)
        assertEquals(WatchPhase.OFFLINE, onlyOffline.phase)
        assertEquals(1, onlyOffline.needsYouCount)
        assertEquals(now.minusSeconds(300), onlyOffline.offlineSince)
        assertEquals(WatchPhase.WORKING, GlanceWatchState.merge(emptyList(), now).phase)
    }

    @Test
    fun wireRoundTripKeepsServerlessFields() {
        val state = GlanceWatchState(WatchPhase.WAITING, head = item("h", 4), others = listOf(item("o", 2)), needsYouCount = 2, runningCount = 1, recurringCount = 4, asOf = now)
        val back = GlanceWatchState.fromWire(state.toWire(), serverId = "s1", serverName = "S1")
        assertEquals(state, back)
        assertEquals(state.contentKey, back.copy(asOf = now.plusSeconds(99)).contentKey, "asOf is not content")
    }

    // endregion

    // region GlanceStore + GlanceLoader.ordered

    @Test
    fun storeCachesPerServerAndMergesTheOldestAsOf() =
        runTest {
            val store = GlanceStore.inMemory()
            val a = NeedsYouSnapshot(needsYou = listOf(item("a", 3, server = "a")), hostsOnline = 1, hostsTotal = 1, asOf = now)
            val b = NeedsYouSnapshot(running = listOf(item("b", 3, "working", server = "b")), hostsOnline = 1, hostsTotal = 1, asOf = now.minusSeconds(60))
            store.setCachedSnapshot(a, "a")
            store.setCachedSnapshot(b, "b")
            assertEquals(a, store.cachedSnapshot("a"))
            val merged = store.mergedCachedSnapshot(listOf("a", "b", "gone"))!!
            assertEquals(listOf("a"), merged.needsYou.map { it.id })
            assertEquals(listOf("b"), merged.running.map { it.id })
            assertEquals(now.minusSeconds(60), merged.asOf)
            assertEquals(2, merged.hostsTotal)

            store.setUnreachableSince(now, "a")
            assertEquals(now, store.unreachableSince("a"))
            store.forgetServer("a")
            assertNull(store.cachedSnapshot("a"))
            assertNull(store.unreachableSince("a"))
            assertNull(store.mergedCachedSnapshot(emptyList()))

            store.setCachedTasks(listOf(InFlightTask(id = "t", title = "Fix", state = "running", startedAt = "2026-09-22T16:00:00Z")), "b")
            assertEquals(Instant.parse("2026-09-22T16:00:00Z"), store.cachedTasks("b").single().since)

            store.snooze("x", now.plusSeconds(900))
            assertEquals(mapOf("x" to now.plusSeconds(900)), store.snoozedUntil(listOf("x", "y")))
            store.setArmed("t1", now)
            assertEquals(now, store.armedAt("t1"))
            store.setArmed("t1", null)
            assertNull(store.armedAt("t1"))
        }

    @Test
    fun orderedMovesLocallySnoozedItemsBackAndMirrorsTheSnooze() {
        val snap =
            NeedsYouSnapshot(
                needsYou = listOf(item("young", 1), item("old", 30), item("mid", 10)),
                running = listOf(item("r1", 50, "working"), item("r2", 5, "working")),
                asOf = now,
            )
        val ordered = GlanceLoader.orderedWith(snap, mapOf("old" to now.plusSeconds(600), "mid" to now.minusSeconds(1)), now)
        assertEquals(listOf("mid", "young", "old"), ordered.needsYou.map { it.id })
        assertEquals(now.plusSeconds(600), ordered.needsYou.last().snoozedUntil)
        assertNull(ordered.needsYou.first().snoozedUntil, "an expired local snooze is ignored")
        assertEquals(listOf("r2", "r1"), ordered.running.map { it.id })
    }

    // endregion

    // region WatchSources

    @Test
    fun followedTasksPersistAndToggle() =
        runTest {
            val store = InMemoryPreferences()
            val sources = WatchSources(store, backgroundScope)
            sources.follow("t1")
            sources.follow("t2")
            assertEquals(setOf("t1", "t2"), sources.followed())
            sources.unfollow("t1")
            assertEquals(setOf("t2"), sources.followedTasks.first { it == setOf("t2") })
            assertFalse(sources.isFollowing("t1"))
            assertTrue(sources.toggle("t1"), "toggle predicts the new state")
            sources.followedTasks.first { "t1" in it }
            // A second instance over the same store sees the same set (persistence).
            assertEquals(setOf("t1", "t2"), WatchSources(store, backgroundScope).followed())
        }

    @Test
    fun recentAgentSendsExpireAfterAnHour() =
        runTest {
            val sources = WatchSources(InMemoryPreferences(), backgroundScope)
            sources.recordAgentSendNow("old", now.minusSeconds(3_700))
            sources.recordAgentSendNow("fresh", now.minusSeconds(60))
            assertEquals(setOf("fresh"), sources.recentAgentSends(now).keys)
            sources.agentSends.first { "fresh" in it }
            assertTrue(sources.isRecentAgentSend("fresh", now))
            assertFalse(sources.isRecentAgentSend("old", now))
        }

    // endregion

    @Test
    fun runTargetIdsRoundTrip() {
        val id = RunTarget.makeId("srv", RunTarget.Kind.JOB, "abc")
        assertEquals("srv|job:abc", id)
        assertEquals(RunTarget.Parts(RunTarget.Kind.JOB, "abc", "srv"), RunTarget.parse(id))
        assertEquals(RunTarget.Parts(RunTarget.Kind.LOCAL, "u-1", null), RunTarget.parse("local:u-1"), "legacy ids fire on the active server")
        assertNull(RunTarget.parse("srv|bogus:1"))
        assertNull(RunTarget.parse("nothing"))
        val target = RunTarget(id, "Nightly", RunTarget.Kind.JOB, serverName = "MBP")
        assertEquals("/api/jobs/abc/runs", target.firePath)
        assertEquals("srv", target.serverId)
        assertEquals("Job · MBP", target.subtitle)
        assertEquals("/api/local/blueprints/u-1/spawn", RunTarget("local:u-1", "Fix", RunTarget.Kind.LOCAL).firePath)
    }

    @Test
    fun pushStateMasksTheTokenLikeTheServer() {
        assertEquals("abcdef…wxyz", PushState.maskToken("abcdef0123456789wxyz"))
        assertEquals("…", PushState.maskToken("short"))
        val state = PushState(token = "abcdef0123456789wxyz", servers = mapOf("s1" to ServerPushState("s1", PushRegistration.REGISTERED, serverCanPush = true)))
        assertTrue(state.server("s1")!!.receivesPush)
        assertEquals("Registered with your Optio server", state.server("s1")!!.label(state))
        val notConfigured = PushState(fcm = FcmAvailability.NotConfigured)
        assertEquals("Push needs a Firebase build", ServerPushState("s1").label(notConfigured))
        assertEquals(
            "The server doesn't have a device registry yet — update Optio.",
            ServerPushState("s1", PushRegistration.UNSUPPORTED).detail(notConfigured),
        )
    }
}
