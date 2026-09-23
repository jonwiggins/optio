package dev.optio.feature.local.stream

import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.network.WsFrame
import dev.optio.core.terminal.TerminalGrid
import dev.optio.core.terminal.TerminalGridMode
import dev.optio.core.terminal.TerminalSizing
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Test

/**
 * [LocalTerminalStream] against a scripted socket and a recording sink: the replay hold, the
 * size-frame handshake, grid ownership (attach never resizes; interaction claims; echoes), the
 * reconnect policy, and input encoding. Mirrors the behaviour of iOS `LocalTerminalStream` and the
 * web's `local-terminal.tsx`.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LocalTerminalStreamTest {
    private class Harness(scope: TestScope, natural: TerminalGrid? = TerminalGrid(50, 20)) {
        val sink = FakeSink(natural)
        val sockets = mutableListOf<FakeStreamSocket>()
        val statuses = mutableListOf<Pair<LocalTerminalState, LocalAttentionState>>()
        val exits = mutableListOf<Int?>()
        val stream =
            LocalTerminalStream(
                terminalId = "t1",
                scope = scope.backgroundScope,
                sink = sink,
                openSocket = { FakeStreamSocket().also { sockets += it } },
            ).also { s ->
                s.onStatus = { st, att -> statuses += st to att }
                s.onExit = { exits += it }
                sink.onGridSizeChanged = { s.onGridSizeChanged(it) }
            }

        val socket: FakeStreamSocket get() = sockets.last()
        val state: LocalTerminalStream.State get() = stream.state.value

        /** Connect and attach to a live terminal whose PTY grid is [grid]. */
        fun attachLive(
            scope: TestScope,
            grid: TerminalGrid = TerminalGrid(160, 45),
            replay: String = "replay",
        ) {
            stream.connect()
            socket.opened()
            socket.status("running")
            if (replay.isNotEmpty()) socket.bytes(replay)
            socket.size(grid.cols, grid.rows)
            scope.runCurrent()
        }
    }

    // region Replay hold

    @Test
    fun replayIsHeldUntilTheSizeFrameLands() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.opened()
            h.socket.status("running")
            h.socket.bytes("\u001b[2J\u001b[1;1Hlaptop screen")
            runCurrent()
            assertEquals("", h.sink.painted(), "held until the grid is known")
            assertTrue(h.sink.holding)

            h.socket.size(160, 45)
            runCurrent()
            assertTrue(h.sink.painted().endsWith("laptop screen"))
            assertEquals(listOf(true), h.sink.releases, "released at the size frame, replies suppressed")
            // The grid landed before the replay was painted.
            val log = h.sink.log
            assertTrue(log.indexOf("mode:Fixed(cols=160, rows=45)") < log.indexOf("release(suppress=true)"), log.toString())
        }

    @Test
    fun heldReplayPlaysAfterTheTimeoutWhenNoSizeComes() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.opened()
            h.socket.bytes("old daemon, no size frame")
            runCurrent()
            advanceTimeBy(LocalTerminalStream.SIZE_HOLD.inWholeMilliseconds - 1)
            runCurrent()
            assertEquals("", h.sink.painted())
            advanceTimeBy(2)
            runCurrent()
            assertEquals("old daemon, no size frame", h.sink.painted())
            assertEquals(listOf(false), h.sink.releases)
        }

    @Test
    fun liveBytesAfterTheSizeFramePaintDirectly() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.socket.bytes(" + live")
            runCurrent()
            assertEquals("replay + live", h.sink.painted())
            assertTrue(h.state.outputSeen)
        }

    // endregion

    // region Grid ownership

    @Test
    fun attachingNeverResizesThePty() =
        runTest {
            val h = Harness(this)
            h.attachLive(this, TerminalGrid(160, 45))
            assertEquals(emptyList(), h.socket.resizes())
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(160, 45)), h.state.mode)
            assertEquals(TerminalGrid(160, 45), h.state.foreignGrid, "sized for another device")
            assertEquals(TerminalGridMode.Fixed(160, 45), h.sink.gridMode)
            assertFalse(h.state.recorded)
        }

    @Test
    fun anAnnouncedGridEqualToOurFitNeedsNoStrip() =
        runTest {
            val h = Harness(this, natural = TerminalGrid(50, 20))
            h.attachLive(this, TerminalGrid(50, 20))
            assertEquals(TerminalSizing.Mode.Unclaimed, h.state.mode)
            assertNull(h.state.foreignGrid)
            assertEquals(TerminalGridMode.Fit, h.sink.gridMode)
            assertEquals(emptyList(), h.socket.resizes())
        }

    @Test
    fun claimTakesTheGridOnceAndItsEchoKeepsIt() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim()
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
            assertEquals(TerminalGridMode.Fit, h.sink.gridMode)
            assertEquals(listOf(TerminalGrid(50, 20)), h.socket.resizes(), "exactly one resize to our fit")
            assertNull(h.state.foreignGrid)

            h.socket.size(50, 20) // the daemon's echo
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
        }

    @Test
    fun anInteractionClaimsBeforeItsInputAndOnlyOnce() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.onInteraction()
            h.stream.sendInput("q")
            h.stream.onInteraction()
            h.stream.sendInput("w")
            runCurrent()
            val kinds = h.socket.sent.map { if (it.contains("\"resize\"")) "resize" else "input" }
            assertEquals(listOf("resize", "input", "input"), kinds)
        }

    @Test
    fun anotherViewerTakingOverDemotesUs() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim()
            h.socket.size(50, 20)
            runCurrent()
            h.socket.size(120, 40) // the laptop claimed it back
            runCurrent()
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(120, 40)), h.state.mode)
            assertEquals(TerminalGridMode.Fixed(120, 40), h.sink.gridMode)
        }

    @Test
    fun ourOwnGridReannouncedForANewViewerStaysOurs() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim()
            h.socket.size(50, 20)
            runCurrent()
            // Another viewer attaches: the daemon re-announces the current (our) grid to everyone.
            h.socket.size(50, 20)
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
            assertNull(h.state.foreignGrid)
        }

    @Test
    fun aStaleEchoOfOurOwnEarlierRequestIsStillOurs() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim() // asks for 50×20
            h.sink.natural = TerminalGrid(90, 12) // rotated before the echo: Fit refits and reports
            runCurrent()
            assertEquals(listOf(TerminalGrid(50, 20), TerminalGrid(90, 12)), h.socket.resizes())
            h.socket.size(50, 20) // echo of the first request lands after the second was sent
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
            h.socket.size(90, 12)
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
        }

    @Test
    fun theOwnerNeverRejudgesTheAnnouncedGridWhenItsFitChanges() =
        runTest {
            // X's emulator rule: the strip coming or going changes the fit; judging the last
            // announcement then would demote the phone, stuck.
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim()
            h.socket.size(50, 20)
            runCurrent()
            h.sink.natural = TerminalGrid(50, 21)
            h.stream.onNaturalGridChanged()
            runCurrent()
            assertEquals(TerminalSizing.Mode.Owner, h.state.mode)
            assertEquals(TerminalGrid(50, 21), h.socket.resizes().last(), "the owner resizes to its new fit instead")
        }

    @Test
    fun aPassiveViewerRejudgesWhenItsFitBecomesKnown() =
        runTest {
            // The Transcript face was showing: no view has laid out, so the grid can't be ours yet.
            val h = Harness(this, natural = null)
            h.attachLive(this, TerminalGrid(50, 20))
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(50, 20)), h.state.mode)
            // The Screen face lays out at exactly that grid: nothing to scale.
            h.sink.natural = TerminalGrid(50, 20)
            h.stream.onNaturalGridChanged()
            runCurrent()
            assertEquals(TerminalSizing.Mode.Unclaimed, h.state.mode)
            assertEquals(emptyList(), h.socket.resizes(), "judging never resizes")
        }

    @Test
    fun anExitedTerminalReplaysItsRecordedScreenPinned() =
        runTest {
            val h = Harness(this, natural = TerminalGrid(132, 40))
            h.stream.connect()
            h.socket.opened()
            h.socket.status("exited", "idle")
            h.socket.size(132, 40) // equal to our fit, still pinned
            h.socket.bytes("final screen")
            h.socket.json("""{"type":"exit","exitCode":0}""")
            runCurrent()
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(132, 40)), h.state.mode)
            assertTrue(h.state.recorded)
            assertTrue(h.state.dead)
            assertTrue(h.state.settled)
            assertEquals(0, h.state.exitCode)
            assertEquals(listOf<Int?>(0), h.exits)
            assertTrue(h.sink.painted().startsWith("final screen"))
            assertTrue(h.sink.painted().contains("[process exited (code 0)]"))

            // A tap on a recorded screen must not reflow it, and nothing can be typed.
            h.stream.claim()
            h.stream.onInteraction()
            assertFalse(h.stream.sendInput("x"))
            runCurrent()
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(132, 40)), h.state.mode)
            assertEquals(emptyList(), h.socket.sent)
        }

    // endregion

    // region Status, exit, errors, reconnects

    @Test
    fun statusFramesReachTheHeader() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.socket.status("running", "needs_you")
            runCurrent()
            assertEquals(
                listOf(LocalTerminalState.RUNNING to LocalAttentionState.WORKING, LocalTerminalState.RUNNING to LocalAttentionState.NEEDS_YOU),
                h.statuses,
            )
            assertEquals(LocalAttentionState.NEEDS_YOU, h.state.attentionState)
            assertEquals(LocalTerminalStream.ConnState.CONNECTED, h.state.conn)
        }

    @Test
    fun theOwnerReassertsItsGridAfterABlip() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.stream.claim()
            h.socket.size(50, 20)
            runCurrent()
            val first = h.socket
            first.closed(1006)
            runCurrent()
            assertEquals(LocalTerminalStream.ConnState.RECONNECTING, h.state.conn)
            advanceTimeBy(LocalTerminalStream.RECONNECT_DELAY.inWholeMilliseconds + 1)
            runCurrent()
            val second = h.socket
            assertTrue(second !== first && second.connected)
            second.opened()
            runCurrent()
            assertEquals(listOf(TerminalGrid(50, 20)), second.resizes(), "re-asserted on open")
        }

    @Test
    fun aReconnectResetsTheScreenOnlyWhenTheReplayArrives() =
        runTest {
            val h = Harness(this)
            h.attachLive(this, replay = "first")
            val resetsAfterAttach = h.sink.resets
            h.socket.closed(4503) // host blip
            runCurrent()
            advanceTimeBy(LocalTerminalStream.RECONNECT_DELAY.inWholeMilliseconds + 1)
            runCurrent()
            h.socket.opened()
            h.socket.status("running")
            runCurrent()
            assertEquals(resetsAfterAttach, h.sink.resets, "nothing came back yet: keep the screen")
            h.socket.bytes("second")
            h.socket.size(160, 45)
            runCurrent()
            assertEquals(resetsAfterAttach + 1, h.sink.resets)
            assertEquals("second", h.sink.painted())
        }

    @Test
    fun permanentClosesStopWithAMessage() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.closed(4403)
            runCurrent()
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(1, h.sockets.size, "no reconnect")
            assertEquals(LocalTerminalStream.ConnState.DISCONNECTED, h.state.conn)
            assertEquals("You don't have permission to view this terminal.", h.state.errorMessage)
            assertTrue(h.state.settled)
        }

    @Test
    fun aDeliberateCloseStopsQuietly() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.socket.closed(1000)
            runCurrent()
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(1, h.sockets.size)
            assertEquals(LocalTerminalStream.ConnState.DISCONNECTED, h.state.conn)
            assertNull(h.state.errorMessage)
        }

    @Test
    fun hostOfflineRetriesUntilBytesFlowAgain() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.opened()
            h.socket.status("running")
            h.socket.json("""{"type":"error","message":"Host is offline"}""")
            runCurrent()
            val first = h.socket
            assertTrue(first.disconnected)
            assertEquals("Host is offline", h.state.errorMessage)
            assertTrue(h.state.retrying)
            assertEquals(LocalTerminalStream.ConnState.RECONNECTING, h.state.conn)

            advanceTimeBy(LocalTerminalStream.RECONNECT_DELAY.inWholeMilliseconds + 1)
            runCurrent()
            assertEquals(2, h.sockets.size)
            h.socket.opened()
            h.socket.status("running")
            h.socket.bytes("back")
            h.socket.size(160, 45)
            runCurrent()
            assertNull(h.state.errorMessage)
            assertFalse(h.state.retrying)
            assertEquals("back", h.sink.painted())
        }

    @Test
    fun aFatalErrorWithoutALiveStatusDoesNotRetry() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.opened()
            h.socket.json("""{"type":"error","message":"Terminal not found"}""")
            h.socket.closed(1005)
            runCurrent()
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals(1, h.sockets.size)
            assertEquals("Terminal not found", h.state.errorMessage)
            assertFalse(h.state.retrying)
            assertEquals(LocalTerminalStream.ConnState.DISCONNECTED, h.state.conn)
        }

    @Test
    fun theUserCanReconnectAfterAStop() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.socket.closed(1000)
            runCurrent()
            h.stream.reconnect()
            runCurrent()
            assertEquals(2, h.sockets.size)
            assertEquals(LocalTerminalStream.ConnState.RECONNECTING, h.state.conn)
            h.socket.opened()
            runCurrent()
            assertEquals(LocalTerminalStream.ConnState.CONNECTED, h.state.conn)
        }

    @Test
    fun disconnectLetsHeldOutputPlayAndStopsListening() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            h.socket.opened()
            h.socket.bytes("held")
            runCurrent()
            val socket = h.socket
            h.stream.disconnect()
            assertTrue(socket.disconnected)
            assertEquals("held", h.sink.painted())
            socket.bytes("late")
            advanceTimeBy(10_000)
            runCurrent()
            assertEquals("held", h.sink.painted())
            assertEquals(1, h.sockets.size)
            assertTrue(h.stream.isDisposed)
        }

    @Test
    fun unknownAndMalformedControlFramesAreIgnored() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            h.socket.json("""{"type":"future-thing","x":1}""")
            h.socket.json("""{"type":"size","cols":"wide"}""")
            h.socket.emit(WsFrame.Text("plain text line"))
            runCurrent()
            assertEquals(TerminalSizing.Mode.Passive(TerminalGrid(160, 45)), h.state.mode)
            assertTrue(h.sink.painted().endsWith("plain text line"), "non-JSON text is rendered, not lost")
        }

    // endregion

    // region Input

    @Test
    fun inputTravelsAsJsonWithEscapesIntact() =
        runTest {
            val h = Harness(this)
            h.attachLive(this)
            assertTrue(h.stream.sendInput("echo \"hi\" ✓\r"))
            assertTrue(h.stream.sendInput(byteArrayOf(0x1b, '['.code.toByte(), 'A'.code.toByte())))
            assertTrue(h.stream.sendInput(byteArrayOf(0x03)))
            assertEquals(listOf("echo \"hi\" ✓\r", "\u001b[A", "\u0003"), h.socket.inputs())
            assertEquals("""{"type":"input","data":"\u001b[A"}""", h.socket.sent[1])
        }

    @Test
    fun resizeFramesCarryIntegers() {
        assertEquals("""{"type":"resize","cols":50,"rows":20}""", LocalTerminalStream.resizeFrame(TerminalGrid(50, 20)))
    }

    @Test
    fun nothingIsSentBeforeTheSocketOpens() =
        runTest {
            val h = Harness(this)
            h.stream.connect()
            runCurrent()
            assertFalse(h.stream.sendInput("ls\r"))
            h.stream.claim() // remembered as sent, transmitted on open (owner re-assert)
            runCurrent()
            assertEquals(emptyList(), h.socket.sent)
            h.socket.opened()
            runCurrent()
            assertEquals(listOf(TerminalGrid(50, 20)), h.socket.resizes())
        }

    // endregion
}
