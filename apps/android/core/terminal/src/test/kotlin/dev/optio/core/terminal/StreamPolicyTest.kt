package dev.optio.core.terminal

import dev.optio.core.terminal.StreamPolicy.CloseAction
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Test

/**
 * Ports iOS `OptioTests/LocalStreamPolicyTests.swift` (every case), which mirrors the web's
 * `components/local/stream-policy.test.ts`.
 */
class StreamPolicyTest {
    private val p = StreamPolicy

    @Test
    fun reconnectsOn4503HostDisconnected() {
        assertEquals(CloseAction.Reconnect, p.closeAction(code = 4503, terminalDead = false, retryRequested = false))
    }

    @Test
    fun reconnectsOnAbnormalAndGoingAway() {
        for (code in listOf(1001, 1006)) {
            assertEquals(CloseAction.Reconnect, p.closeAction(code = code, terminalDead = false, retryRequested = false))
        }
    }

    @Test
    fun stopsWithMessageOnPermanentRejections() {
        for (code in listOf(4401, 4403, 4429)) {
            assertEquals(
                CloseAction.Stop(p.permanentCloseMessages[code]),
                p.closeAction(code = code, terminalDead = false, retryRequested = false),
            )
        }
    }

    @Test
    fun permanentRejectionsWinOverRetryRequest() {
        assertEquals(
            CloseAction.Stop(p.permanentCloseMessages[4403]),
            p.closeAction(code = 4403, terminalDead = false, retryRequested = true),
        )
    }

    @Test
    fun neverReconnectsOnceTerminalIsDead() {
        for (code in listOf(1000, 1006, 4503)) {
            assertEquals(CloseAction.Stop(null), p.closeAction(code = code, terminalDead = true, retryRequested = false))
        }
    }

    @Test
    fun doesNotLoopOnDeliberateNormalCloses() {
        for (code in listOf(1000, 1005)) {
            assertEquals(CloseAction.Stop(null), p.closeAction(code = code, terminalDead = false, retryRequested = false))
        }
    }

    @Test
    fun selfInitiatedRetryCloseReconnects() {
        assertEquals(CloseAction.Reconnect, p.closeAction(code = 1000, terminalDead = false, retryRequested = true))
    }

    @Test
    fun onlyExitedAndErrorAreDead() {
        assertTrue(p.isTerminalStateDead("exited"))
        assertTrue(p.isTerminalStateDead("error"))
        assertFalse(p.isTerminalStateDead("running"))
        assertFalse(p.isTerminalStateDead("launching"))
        assertFalse(p.isTerminalStateDead("pending"))
        assertFalse(p.isTerminalStateDead("__unknown__"))
    }

    @Test
    fun permanentMessagesAreThePhoneCopy() {
        assertEquals("Authentication failed — sign in again.", p.permanentCloseMessages[4401])
        assertEquals("You don't have permission to view this terminal.", p.permanentCloseMessages[4403])
        assertEquals("Too many connections — close other Optio clients.", p.permanentCloseMessages[4429])
    }
}
