package dev.optio.feature.local.machines

import dev.optio.core.model.LocalAttentionState
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.testing.Samples
import kotlin.test.assertEquals
import org.junit.Test

class HostTerminalsTest {
    @Test
    fun groupsInTheOrderYoudActOnThem() {
        val waitingLong = Samples.localTerminal(id = "a", attentionState = LocalAttentionState.NEEDS_YOU, lastActivityAt = Samples.agoIso(30))
        val waitingShort = Samples.localTerminal(id = "b", attentionState = LocalAttentionState.NEEDS_YOU, lastActivityAt = Samples.agoIso(2))
        val working = Samples.localTerminal(id = "c", attentionState = LocalAttentionState.WORKING, lastActivityAt = Samples.agoIso(1))
        val held = Samples.localTerminal(id = "d", state = LocalTerminalState.PENDING, attentionState = LocalAttentionState.IDLE)
        val oldDone = Samples.localTerminal(id = "e", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.IDLE, exitCode = 0, lastActivityAt = Samples.agoIso(90))
        val newDone = Samples.localTerminal(id = "f", state = LocalTerminalState.EXITED, attentionState = LocalAttentionState.NEEDS_YOU, exitCode = 0, lastActivityAt = Samples.agoIso(10))

        val grouped = HostTerminals.grouped(listOf(oldDone, working, waitingShort, held, newDone, waitingLong))
        assertEquals(
            listOf(
                HostTerminals.Group.NEEDS_YOU to listOf("a", "b"), // oldest wait first
                HostTerminals.Group.RUNNING to listOf("c"),
                HostTerminals.Group.PENDING to listOf("d"),
                HostTerminals.Group.FINISHED to listOf("f", "e"), // newest first; a finished run is never "waiting"
            ),
            grouped.map { (g, ts) -> g to ts.map { it.id } },
        )
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
}
