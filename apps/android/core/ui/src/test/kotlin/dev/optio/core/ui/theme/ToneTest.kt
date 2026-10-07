package dev.optio.core.ui.theme

import androidx.compose.ui.graphics.Color
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue

/** `Tone.forState` / `StatusKind.forState` are the one state → colour map (iOS Tokens + StatusColor). */
class ToneTest {
    @Test
    fun needsYouStatesAreAccent() {
        listOf(
            "needs_attention", "needs_you", "review_requested",
            "changes_requested", "request_changes", "ready", "attention",
        ).forEach { state ->
            assertEquals(Tone.ACCENT, Tone.forState(state), state)
            assertEquals(StatusKind.NEEDS_INPUT, StatusKind.forState(state), state)
        }
    }

    @Test
    fun problemsAreWarning() {
        listOf(
            "failed", "error", "stalled", "reconnecting", "disconnected", "offline", "crashloopbackoff", "imagepullbackoff", "errimagepull",
            "notready", "failing", "unhealthy", "oom_killed", "oomkilled", "crashed", "evicted",
        ).forEach { state ->
            assertEquals(Tone.WARNING, Tone.forState(state), state)
            assertEquals(StatusKind.FAILED, StatusKind.forState(state), state)
        }
    }

    @Test
    fun finishedStatesAreNeutral() {
        listOf(
            "completed", "merged", "approved", "approve", "success", "succeeded", "healthy", "passing",
            "submitted", "done", "orphan_cleaned", "ready_node", "online_host",
        ).forEach { state ->
            assertEquals(Tone.IDLE, Tone.forState(state), state)
            assertEquals(StatusKind.COMPLETED, StatusKind.forState(state), state)
        }
    }

    @Test
    fun activeStatesAreWorking() {
        listOf(
            "running", "active", "online", "working", "provisioning", "launching", "reviewing", "pr_opened",
            "connected", "connecting", "in_progress", "processing", "live", "open", "restarted",
        ).forEach { state ->
            assertEquals(Tone.WORKING, Tone.forState(state), state)
            assertEquals(StatusKind.WORKING, StatusKind.forState(state), state)
        }
    }

    @Test
    fun queuedAndPendingDifferBetweenToneAndStatusKind() {
        // iOS: the widgets' StatusKind counts queued work as working; rows (Tone) keep it idle.
        for (state in listOf("queued", "pending")) {
            assertEquals(Tone.IDLE, Tone.forState(state))
            assertEquals(StatusKind.WORKING, StatusKind.forState(state))
        }
    }

    @Test
    fun unknownNullAndCaseInsensitive() {
        assertEquals(Tone.IDLE, Tone.forState(null))
        assertEquals(Tone.IDLE, Tone.forState(""))
        assertEquals(Tone.IDLE, Tone.forState("exited"))
        assertEquals(Tone.IDLE, Tone.forState("cancelled"))
        for (state in listOf("dead", "closed", "paused", "held", "waiting_for_off_peak")) {
            assertEquals(Tone.IDLE, Tone.forState(state))
            assertEquals(StatusKind.DEAD, StatusKind.forState(state))
        }
        assertEquals(StatusKind.DEAD, StatusKind.forState("archived"))
        assertEquals(StatusKind.DEAD, StatusKind.forState(null))
        assertEquals(Tone.WARNING, Tone.forState("CrashLoopBackOff"))
        assertEquals(Tone.ACCENT, Tone.forState("NEEDS_ATTENTION"))
    }

    @Test
    fun onlyNeedsYouFailedAndWorkingShowADot() {
        assertTrue(Tone.ACCENT.showsDot)
        assertTrue(Tone.DANGER.showsDot)
        assertTrue(Tone.WARNING.showsDot)
        assertTrue(Tone.WORKING.showsDot)
        assertFalse(Tone.SUCCESS.showsDot)
        assertFalse(Tone.IDLE.showsDot)
        assertFalse(Tone.MUTED.showsDot)
    }

    @Test
    fun paletteMatchesIos() {
        val light = OptioColors.Light
        val dark = OptioColors.Dark
        // purple = working, the same in both modes
        assertEquals(Color(0xFF6D28D9), Tone.WORKING.color(light))
        assertEquals(Color(0xFFB49AF7), Tone.WORKING.color(dark))
        // green = needs you; yellow = problems, with contrast in both appearances
        assertEquals(Color(0xFF087F5B), Tone.ACCENT.color(light))
        assertEquals(Color(0xFF30D159), Tone.ACCENT.color(dark))
        assertEquals(Color(0xFF8A6500), Tone.WARNING.color(light))
        assertEquals(Color(0xFFF0C451), Tone.WARNING.color(dark))
        // Successful actions stay green; destructive actions stay red.
        assertEquals(Color(0xFF087F5B), Tone.SUCCESS.color(light))
        assertEquals(Color(0xFF30D159), Tone.SUCCESS.color(dark))
        assertEquals(Color(0xFFFF3B30), Tone.DANGER.color(light))
        assertEquals(Color(0xFFFF453A), Tone.DANGER.color(dark))
        // grey = idle (tertiaryLabel); idle text is tertiary, muted quaternary
        assertEquals(light.tertiaryLabel, Tone.IDLE.color(light))
        assertEquals(light.tertiaryLabel, Tone.IDLE.textColor(light))
        assertEquals(light.quaternaryLabel, Tone.MUTED.textColor(light))
        assertEquals(StatusPalette.GREEN_DARK, StatusKind.NEEDS_INPUT.argb(dark = true))
        assertEquals(StatusPalette.PURPLE, StatusKind.WORKING.argb(dark = false))
        assertEquals(StatusPalette.YELLOW_DARK, StatusKind.FAILED.argb(dark = true))
        assertEquals(StatusPalette.GREY_LIGHT, StatusKind.COMPLETED.argb(dark = false))
        assertEquals(Color(StatusPalette.GREY_LIGHT), StatusKind.DEAD.color(light))
    }

    @Test
    fun statusKindLabels() {
        assertEquals(listOf("working", "needs input", "completed", "failed", "stopped"), StatusKind.entries.map { it.label })
    }

    @Test
    fun appearanceRawValues() {
        assertEquals(AppAppearance.DARK, AppAppearance.fromRaw("dark"))
        assertEquals(AppAppearance.LIGHT, AppAppearance.fromRaw("light"))
        assertEquals(AppAppearance.SYSTEM, AppAppearance.fromRaw("system"))
        assertEquals(AppAppearance.SYSTEM, AppAppearance.fromRaw(null))
        assertEquals(AppAppearance.SYSTEM, AppAppearance.fromRaw("sepia"))
        assertEquals("optio.appearance", AppAppearance.STORAGE_KEY)
    }
}
