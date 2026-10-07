package dev.optio.feature.local.machines

import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.testing.Samples
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Test

class HostTerminalsTest {
    @Test
    fun ordersByLastInteractionThenCreationIgnoringAttention() {
        // Typed into 1 min ago, created long ago: first, whatever its attention state.
        val typed = Samples.localTerminal(id = "a", attentionState = LocalAttentionState.WORKING, createdAt = Samples.agoIso(120)).copy(lastInteractedAt = Samples.agoIso(1))
        // Never typed into: falls back to createdAt.
        val newest = Samples.localTerminal(id = "b", attentionState = LocalAttentionState.NEEDS_YOU, createdAt = Samples.agoIso(5))
        val older = Samples.localTerminal(id = "c", attentionState = LocalAttentionState.NEEDS_YOU, createdAt = Samples.agoIso(60))
        val held = Samples.localTerminal(id = "d", state = LocalTerminalState.PENDING, attentionState = LocalAttentionState.IDLE, createdAt = Samples.agoIso(30))
        val oldDone = Samples.localTerminal(id = "e", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.IDLE, exitCode = 0, createdAt = Samples.agoIso(90))
        val newDone = Samples.localTerminal(id = "f", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.NEEDS_YOU, exitCode = 0, createdAt = Samples.agoIso(10))

        val grouped = HostTerminals.grouped(listOf(oldDone, older, newest, held, newDone, typed))
        assertEquals(
            listOf(
                HostTerminals.Group.LIVE to listOf("a", "b", "d", "c"),
                HostTerminals.Group.FINISHED to listOf("f", "e"),
            ),
            grouped.map { (g, ts) -> g to ts.map { it.id } },
        )
    }

    @Test
    fun attentionChangesDoNotMoveRows() {
        val list =
            listOf(
                Samples.localTerminal(id = "x", attentionState = LocalAttentionState.WORKING, createdAt = Samples.agoIso(3)),
                Samples.localTerminal(id = "y", attentionState = LocalAttentionState.NEEDS_YOU, createdAt = Samples.agoIso(4)),
            )
        val flipped = list.map { it.copy(attentionState = if (it.attentionState == LocalAttentionState.WORKING) LocalAttentionState.NEEDS_YOU else LocalAttentionState.WORKING) }
        assertEquals(HostTerminals.ordered(list).map { it.id }, HostTerminals.ordered(flipped).map { it.id })
    }

    @Test
    fun tiesBreakOnCreationThenId() {
        val at = Samples.agoIso(5)
        val b = Samples.localTerminal(id = "b", createdAt = at)
        val a = Samples.localTerminal(id = "a", createdAt = at)
        val typedSame = Samples.localTerminal(id = "c", createdAt = Samples.agoIso(50)).copy(lastInteractedAt = at)
        assertEquals(listOf("a", "b", "c"), HostTerminals.ordered(listOf(typedSame, b, a)).map { it.id })
    }

    @Test
    fun nextNeedsYouCyclesInVisualOrder() {
        val list =
            listOf(
                Samples.localTerminal(id = "w", attentionState = LocalAttentionState.WORKING, createdAt = Samples.agoIso(1)),
                Samples.localTerminal(id = "n1", attentionState = LocalAttentionState.NEEDS_YOU, createdAt = Samples.agoIso(2)),
                Samples.localTerminal(id = "n2", attentionState = LocalAttentionState.NEEDS_YOU, createdAt = Samples.agoIso(3)),
                Samples.localTerminal(id = "done", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.NEEDS_YOU, exitCode = 0, createdAt = Samples.agoIso(0)),
            )
        assertEquals(2, HostTerminals.needsYouCount(list))
        assertEquals("n1", HostTerminals.nextNeedsYou(list, null)?.id)
        assertEquals("n2", HostTerminals.nextNeedsYou(list, "n1")?.id)
        assertEquals("n1", HostTerminals.nextNeedsYou(list, "n2")?.id)
        assertEquals("n1", HostTerminals.nextNeedsYou(list, "gone")?.id)
        assertNull(HostTerminals.nextNeedsYou(list.filter { it.id == "w" }, null))
    }

    @Test
    fun onlineMachinesSortFirstThenByName() {
        val sorted =
            MachinesViewModel.sortHosts(
                listOf(
                    Samples.localHost(id = "1", name = "zeta", state = LocalHostState.OFFLINE),
                    Samples.localHost(id = "2", name = "beta"),
                    Samples.localHost(id = "3", name = "Alpha", state = LocalHostState.OFFLINE),
                    Samples.localHost(id = "4", name = "alpha2"),
                ),
            )
        assertEquals(listOf("alpha2", "beta", "Alpha", "zeta"), sorted.map { it.name })
    }

    @Test
    fun pinnedSessionsComeFirstWithinTheirGroup() {
        // Pinned long ago and never typed into: still first. Among the pinned, the usual order.
        val pinnedOld = Samples.localTerminal(id = "p1", createdAt = Samples.agoIso(300)).copy(pinnedAt = Samples.agoIso(200))
        val pinnedTyped = Samples.localTerminal(id = "p2", createdAt = Samples.agoIso(250)).copy(pinnedAt = Samples.agoIso(100), lastInteractedAt = Samples.agoIso(3))
        val typed = Samples.localTerminal(id = "a", createdAt = Samples.agoIso(120)).copy(lastInteractedAt = Samples.agoIso(1))
        val newest = Samples.localTerminal(id = "b", createdAt = Samples.agoIso(5))
        val doneOld = Samples.localTerminal(id = "e", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.IDLE, exitCode = 0, createdAt = Samples.agoIso(90))
        val donePinned = Samples.localTerminal(id = "f", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.IDLE, exitCode = 0, createdAt = Samples.agoIso(400)).copy(pinnedAt = Samples.agoIso(10))

        val grouped = HostTerminals.grouped(listOf(doneOld, newest, pinnedOld, typed, donePinned, pinnedTyped))
        assertEquals(
            listOf(
                HostTerminals.Group.LIVE to listOf("p2", "p1", "a", "b"),
                HostTerminals.Group.FINISHED to listOf("f", "e"),
            ),
            grouped.map { (g, ts) -> g to ts.map { it.id } },
        )
        // Unpinning puts each back where its interaction time says (p2 was typed into 3 min ago, b made 5 min ago).
        assertEquals(listOf("a", "p2", "b", "p1"), HostTerminals.ordered(listOf(newest, pinnedOld.copy(pinnedAt = null), typed, pinnedTyped.copy(pinnedAt = null))).map { it.id })
    }
}
