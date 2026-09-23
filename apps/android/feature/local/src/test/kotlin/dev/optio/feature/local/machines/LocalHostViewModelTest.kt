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
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.builtins.ListSerializer
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

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
}
