package dev.optio.feature.local.model

import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

/**
 * Port of iOS `LocalSessionViewTests` (itself the web's `session-view.test.ts`), with the phone's
 * rule: the transcript is the default whenever there is one, live or not.
 */
class LocalSessionViewTest {
    private val r = LocalSessionViewRule

    @Test
    fun honorsExplicitChoice() {
        assertEquals(LocalSessionView.SCREEN, r.resolve(LocalSessionView.SCREEN, hasTranscript = true, loaded = true))
        assertEquals(LocalSessionView.TRANSCRIPT, r.resolve(LocalSessionView.TRANSCRIPT, hasTranscript = false, loaded = false))
    }

    @Test
    fun waitsForTranscriptFetchBeforeDeciding() {
        assertNull(r.resolve(null, hasTranscript = false, loaded = false))
    }

    @Test
    fun prefersTranscriptWhileLiveAndWhenFinished() {
        assertEquals(LocalSessionView.TRANSCRIPT, r.resolve(null, hasTranscript = true, loaded = true))
    }

    @Test
    fun fallsBackToScreenWithoutTranscript() {
        // A plain shell, or an agent that hasn't said anything yet.
        assertEquals(LocalSessionView.SCREEN, r.resolve(null, hasTranscript = false, loaded = true))
    }
}
