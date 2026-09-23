package dev.optio.feature.widgets.work

import dev.optio.core.data.InMemoryPreferences
import dev.optio.feature.widgets.data.CachedItem
import dev.optio.feature.widgets.data.CachedSlice
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.model.GlancePolicy
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * A widget's entry from the per-server cache (iOS `GlanceTimelineProvider.load` + `ordered`):
 * the Server option, per-server honesty, and the local "Later" mirror.
 */
class WorkEntryBuilderTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")
    private val servers = listOf(WidgetSamples.laptop, WidgetSamples.studio)

    private fun cache(
        serverId: String,
        needs: List<CachedItem> = emptyList(),
        running: List<CachedItem> = emptyList(),
        unreachableSince: Instant? = null,
        asOf: Instant = now,
    ) = CachedSlice(serverId, needs, running, WidgetSamples.counts, asOf = asOf, unreachableSince = unreachableSince)

    @Test
    fun signedOutWithoutServers() =
        runTest {
            val store = WidgetStore(InMemoryPreferences())
            assertEquals(GlancePolicy.Reachability.SIGNED_OUT, WorkEntryBuilder.build(emptyList(), store.snapshot(), null, now).reachability)
        }

    @Test
    fun allServersByDefaultOneWhenChosen() =
        runTest {
            val store = WidgetStore(InMemoryPreferences())
            store.setCached(cache("srv-laptop", needs = listOf(CachedItem.of(WidgetSamples.web(now)))))
            store.setCached(cache("srv-studio", running = listOf(CachedItem.of(WidgetSamples.docs(now)))))
            val prefs = store.snapshot()

            val all = WorkEntryBuilder.build(servers, prefs, null, now)
            assertEquals(listOf("srv-laptop", "srv-studio"), all.slices.map { it.server.id })
            assertFalse(all.othersPaired)

            val studio = WorkEntryBuilder.build(servers, prefs, "srv-studio", now)
            assertEquals(listOf("srv-studio"), studio.slices.map { it.server.id })
            assertTrue(studio.othersPaired)
            assertEquals(listOf("t-docs"), studio.sessionRows.map { it.id })

            val forgotten = WorkEntryBuilder.build(servers, prefs, "srv-gone", now)
            assertEquals(2, forgotten.slices.size, "a server that is no longer paired falls back to all")
        }

    @Test
    fun anUnreachableServerOnlyFlagsItsOwnRows() =
        runTest {
            val store = WidgetStore(InMemoryPreferences())
            store.setCached(cache("srv-laptop", needs = listOf(CachedItem.of(WidgetSamples.web(now)))))
            store.setCached(cache("srv-studio", needs = listOf(CachedItem.of(WidgetSamples.forge(now))), asOf = now.minus(Duration.ofMinutes(30))))
            store.markUnreachable("srv-studio", now.minus(Duration.ofMinutes(9)))
            store.markUnreachable("srv-studio", now) // a later failure keeps the first time

            val entry = WorkEntryBuilder.build(servers, store.snapshot(), null, now)
            assertEquals(GlancePolicy.Reachability.LIVE, entry.reachability)
            assertEquals(listOf("srv-studio"), entry.unreachableSlices.map { it.server.id })
            assertEquals(now.minus(Duration.ofMinutes(9)), entry.unreachableSince)
            assertEquals(listOf("a-vesper", "t-web"), entry.needsYou.map { it.id }, "the offline server's last good rows stay")
        }

    @Test
    fun aServerNeverLoadedReadsLiveAndEmpty() =
        runTest {
            val entry = WorkEntryBuilder.build(listOf(WidgetSamples.laptop), WidgetStore(InMemoryPreferences()).snapshot(), null, now)
            assertEquals(GlancePolicy.Reachability.LIVE, entry.reachability)
            assertTrue(entry.sessionRows.isEmpty())
            assertFalse(entry.isStale)
            assertNull(entry.tileCounts)
        }

    @Test
    fun laterMovesAnItemBackAndMirrorsOntoIt() =
        runTest {
            val store = WidgetStore(InMemoryPreferences())
            store.setCached(cache("srv-laptop", needs = listOf(CachedItem.of(WidgetSamples.web(now)), CachedItem.of(WidgetSamples.api(now)))))
            assertEquals(listOf("t-api", "t-web"), WorkEntryBuilder.build(servers.take(1), store.snapshot(), null, now).needsYou.map { it.id }, "oldest first")

            store.snooze("t-api", now.plus(Duration.ofMinutes(15)))
            val entry = WorkEntryBuilder.build(servers.take(1), store.snapshot(), null, now)
            assertEquals(listOf("t-web", "t-api"), entry.needsYou.map { it.id })
            assertEquals(now.plus(Duration.ofMinutes(15)), entry.needsYou.last().snoozedUntil, "mirrored so multi-server merges see it")

            val later = WorkEntryBuilder.build(servers.take(1), store.snapshot(), null, now.plus(Duration.ofMinutes(16)))
            assertEquals(listOf("t-api", "t-web"), later.needsYou.map { it.id }, "the window closed")
        }

    @Test
    fun cachedItemsRoundTrip() {
        val item = WidgetSamples.forge(now)
        assertEquals(item, CachedItem.of(item).toItem())
    }
}
