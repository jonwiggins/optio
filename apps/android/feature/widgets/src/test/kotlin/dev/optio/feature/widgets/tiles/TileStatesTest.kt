package dev.optio.feature.widgets.tiles

import android.service.quicksettings.Tile
import dev.optio.core.data.InMemoryPreferences
import dev.optio.feature.widgets.R
import dev.optio.feature.widgets.data.CachedItem
import dev.optio.feature.widgets.data.CachedSlice
import dev.optio.feature.widgets.data.WidgetStore
import dev.optio.feature.widgets.run.RunFiring
import dev.optio.feature.widgets.run.RunTarget
import dev.optio.feature.widgets.work.WidgetSamples
import java.time.Duration
import java.time.Instant
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Test

/** The Quick Settings tiles' looks (iOS `NeedsYouControl`, `NewWorkControl`, `RunTargetControl`). */
class TileStatesTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")

    @Test
    fun needsYouSignedOut() {
        val look = TileStates.needsYou(signedIn = false, needsYou = emptyList(), multiServer = false)
        assertEquals("Sign in to Optio", look.subtitle)
        assertEquals(Tile.STATE_INACTIVE, look.state)
    }

    @Test
    fun needsYouQuiet() {
        val look = TileStates.needsYou(signedIn = true, needsYou = emptyList(), multiServer = false)
        assertEquals("Needs you", look.label)
        assertEquals("Quiet", look.subtitle)
        assertEquals(Tile.STATE_INACTIVE, look.state, "grey when quiet")
        assertEquals(R.drawable.widget_ic_moon, look.icon)
        assertEquals("Quiet. No session needs you.", look.description)
    }

    @Test
    fun needsYouCountsAndNamesTheOldest() {
        val look = TileStates.needsYou(signedIn = true, needsYou = listOf(WidgetSamples.api(now), WidgetSamples.web(now)), multiServer = false)
        assertEquals("2 · api", look.subtitle)
        assertEquals(Tile.STATE_ACTIVE, look.state)
        assertEquals(R.drawable.widget_ic_bot, look.icon)
        assertEquals("2 sessions need you. Oldest: optio/apps/api.", look.description)

        val one = TileStates.needsYou(signedIn = true, needsYou = listOf(WidgetSamples.forge(now)), multiServer = true)
        assertEquals("1 · Vesper", one.subtitle)
        assertEquals("1 session needs you. Oldest: @vesper · Studio.", one.description, "names the server when several are paired")
    }

    @Test
    fun needsYouReadsEveryServersCacheWithLaterLast() =
        runTest {
            val store = WidgetStore(InMemoryPreferences())
            store.setCached(CachedSlice("srv-laptop", needsYou = listOf(CachedItem.of(WidgetSamples.web(now))), asOf = now))
            store.setCached(CachedSlice("srv-studio", needsYou = listOf(CachedItem.of(WidgetSamples.forge(now))), asOf = now))
            store.snooze("a-vesper", now.plus(Duration.ofMinutes(15)))
            val merged = TileStates.mergedNeedsYou(listOf(WidgetSamples.laptop, WidgetSamples.studio), store.snapshot(), now)
            assertEquals(listOf("t-web", "a-vesper"), merged.map { it.id })
            assertTrue(TileStates.mergedNeedsYou(emptyList(), store.snapshot(), now).isEmpty())
        }

    @Test
    fun newWorkIsStatic() {
        assertEquals("New work", TileStates.newWork(true).label)
        assertEquals("When · Where · Who · What", TileStates.newWork(true).subtitle)
        assertEquals("Sign in to Optio", TileStates.newWork(false).subtitle)
        assertEquals(R.drawable.widget_ic_new_work, TileStates.newWork(true).icon)
    }

    @Test
    fun runTargetStates() {
        val target = RunTarget("srv|job:1", "Nightly", RunTarget.Kind.JOB, serverName = "MacBook")
        assertEquals("Choose a blueprint", TileStates.runTarget(true, null, false).subtitle)
        assertEquals("Run", TileStates.runTarget(true, null, false).label)
        assertEquals("Sign in to Optio", TileStates.runTarget(false, target, false).subtitle)

        val idle = TileStates.runTarget(true, target, justStarted = false)
        assertEquals("Run Nightly", idle.label)
        assertEquals("Job · MacBook", idle.subtitle)
        assertEquals(Tile.STATE_INACTIVE, idle.state)
        assertEquals(R.drawable.widget_ic_play, idle.icon)

        val firing = TileStates.runTarget(true, target, justStarted = false, firing = true)
        assertEquals("Starting…", firing.subtitle)

        val started = TileStates.runTarget(true, target, justStarted = true)
        assertEquals("Started", started.subtitle)
        assertEquals(Tile.STATE_ACTIVE, started.state)
        assertEquals(R.drawable.widget_ic_check, started.icon)
    }

    @Test
    fun tileCheckmarkLastsAboutThreeSeconds() {
        assertTrue(RunFiring.tileShowsStarted(now.minusSeconds(2), now))
        assertFalse(RunFiring.tileShowsStarted(now.minusSeconds(4), now))
        assertFalse(RunFiring.tileShowsStarted(null, now))
        assertFalse(RunFiring.tileShowsStarted(now.plusSeconds(1), now), "a clock that went back never flashes")
    }

    @Test
    fun runMessagesFollowIos() {
        val job = RunTarget("s|job:1", "Nightly", RunTarget.Kind.JOB)
        val blueprint = RunTarget("s|local:2", "Fix flaky tests", RunTarget.Kind.LOCAL, spawnMode = "hold")
        assertEquals("Started Nightly.", RunFiring.message(RunFiring.Outcome.Started(job, dev.optio.feature.widgets.run.FireReceipt())))
        assertEquals("Started Fix flaky tests in web.", RunFiring.message(RunFiring.Outcome.Started(blueprint, dev.optio.feature.widgets.run.FireReceipt(dir = "web"))))
        assertEquals(
            "Fix flaky tests is ready — start it from Optio.",
            RunFiring.message(RunFiring.Outcome.Started(blueprint, dev.optio.feature.widgets.run.FireReceipt(held = true))),
        )
        assertEquals("Couldn't start Nightly.", RunFiring.message(RunFiring.Outcome.Failed(job, "500")))
        assertEquals("Sign in to Optio first.", RunFiring.message(RunFiring.Outcome.SignedOut))
        assertEquals("Tap again to run Nightly.", RunFiring.message(RunFiring.Outcome.Armed(job)))
    }
}
