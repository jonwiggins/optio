package dev.optio.feature.local.machines

import android.os.Looper
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalHost
import dev.optio.core.model.OptioJson
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.testing.Samples
import dev.optio.core.ui.state.LoadState
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf
import dev.optio.core.model.LocalTerminal

/** [LocalHostViewModel] (the machine page) against [dev.optio.core.testing.FakeOptioServer]. */
@OptIn(ExperimentalCoroutinesApi::class)
@RunWith(AndroidJUnit4::class)
class LocalHostViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    private fun TestScope.awaitReal(
        what: String,
        timeoutMs: Long = 5_000,
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            runCurrent()
            shadowOf(Looper.getMainLooper()).idle()
            if (condition()) return
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    @Test
    fun automationRowsKnowTheirTriggers() =
        runTest(main.dispatcher) {
            // QA: the page passed no triggers, so every automation read "Runs when you press Run".
            val host = Samples.localHost()
            val scheduled = Samples.localBlueprint(id = "bp-scheduled").copy(hostId = host.id)
            val broken = Samples.localBlueprint(id = "bp-broken", name = "Broken").copy(hostId = host.id)
            val elsewhere = Samples.localBlueprint(id = "bp-elsewhere", name = "Elsewhere").copy(hostId = "another-host")
            server.get("/api/local/hosts") { FakeResponse.json("""{"hosts":${OptioJson.encodeToString(ListSerializer(LocalHost.serializer()), listOf(host))}}""") }
            server.get("/api/local/terminals") { FakeResponse.json("""{"terminals":[]}""") }
            server.get("/api/local/blueprints") {
                FakeResponse.json("""{"blueprints":${OptioJson.encodeToString(ListSerializer(LocalBlueprint.serializer()), listOf(scheduled, broken, elsewhere))}}""")
            }
            server.fixture("/api/local/blueprints/bp-scheduled/triggers", "local-blueprint-triggers.json")
            server.error("GET", "/api/local/blueprints/bp-broken/triggers", 500, "boom")

            val vm = LocalHostViewModel(server.client(), host.id)
            awaitReal("the page") { vm.page.value is LoadState.Loaded }
            val page = vm.page.value.value!!
            assertEquals(listOf("bp-scheduled", "bp-broken"), page.automations.map { it.id })
            assertEquals(listOf("schedule"), page.triggers["bp-scheduled"]!!.map { it.type })
            assertFalse("bp-broken" in page.triggers, "unknown, not \"none\": the row shows no trigger line")
        }

    @Test
    fun togglePinMovesTheRowAtOnceAndKeepsTheServersAnswer() =
        runTest(main.dispatcher) {
            val host = Samples.localHost()
            val a = Samples.localTerminal(id = "a", createdAt = Samples.agoIso(5)).copy(hostId = host.id)
            val b = Samples.localTerminal(id = "b", createdAt = Samples.agoIso(60)).copy(hostId = host.id)
            server.get("/api/local/hosts") { FakeResponse.json("""{"hosts":${OptioJson.encodeToString(ListSerializer(LocalHost.serializer()), listOf(host))}}""") }
            server.get("/api/local/terminals") { FakeResponse.json("""{"terminals":${OptioJson.encodeToString(ListSerializer(LocalTerminal.serializer()), listOf(a, b))}}""") }
            server.get("/api/local/blueprints") { FakeResponse.json("""{"blueprints":[]}""") }
            val serverPinnedAt = "2026-09-30T09:00:00.000Z"
            server.post("/api/local/terminals/:id/pin") { FakeResponse.json("""{"terminal":${OptioJson.encodeToString(LocalTerminal.serializer(), b.copy(pinnedAt = serverPinnedAt))}}""") }
            server.error("DELETE", "/api/local/terminals/:id/pin", 500, "boom")
            val vm = LocalHostViewModel(server.client(), host.id)
            awaitReal("the page") { vm.page.value is LoadState.Loaded }
            fun order() = HostTerminals.ordered(vm.page.value.value!!.terminals).map { it.id }
            assertEquals(listOf("a", "b"), order())

            vm.togglePin(b)
            // Optimistic: b leads before the server answers; then the server's row (its own pinnedAt) replaces it.
            assertEquals(listOf("b", "a"), order())
            awaitReal("the server's row") { vm.page.value.value!!.terminals.first { it.id == "b" }.pinnedAt == serverPinnedAt }
            assertEquals(1, server.count("POST", "/api/local/terminals/:id/pin"))

            // A refused unpin puts the row back as it was and reports the failure.
            val events = mutableListOf<LocalHostViewModel.Event>()
            val collector = backgroundScope.launch { vm.events.collect { events += it } }
            vm.togglePin(vm.page.value.value!!.terminals.first { it.id == "b" })
            awaitReal("the failure") { events.any { it is LocalHostViewModel.Event.Failed } }
            assertEquals(serverPinnedAt, vm.page.value.value!!.terminals.first { it.id == "b" }.pinnedAt)
            assertEquals("unpin the session", (events.first() as LocalHostViewModel.Event.Failed).verb)
            collector.cancel()
        }
}
