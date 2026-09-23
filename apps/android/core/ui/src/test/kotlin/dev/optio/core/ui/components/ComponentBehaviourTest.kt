package dev.optio.core.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.Button
import androidx.compose.material3.Text
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.semantics.SemanticsProperties
import androidx.compose.ui.test.SemanticsMatcher
import androidx.compose.ui.test.assert
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.compose.ui.text.AnnotatedString
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.network.ApiError
import dev.optio.core.network.LocalApiClient
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.Samples
import dev.optio.core.testing.UsageSamples
import dev.optio.core.ui.log.AgentLogView
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.core.ui.toast.ToastHost
import dev.optio.core.ui.toast.Toaster
import dev.optio.core.ui.toast.rememberToaster
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.ObservesUsage
import dev.optio.core.ui.usage.UsageStore
import dev.optio.core.ui.usage.rememberUsageStore
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** Interactive behaviour of the shared components under Robolectric. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ComponentBehaviourTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val server = FakeOptioServerRule()

    @Test
    fun toastsShowAndDismissOnTheirOwn() {
        compose.mainClock.autoAdvance = false
        lateinit var toaster: Toaster
        compose.setContent {
            OptioTheme {
                toaster = rememberToaster()
                CompositionLocalProvider(LocalToaster provides toaster) {
                    Box(Modifier.fillMaxSize()) { ToastHost(toaster, Modifier.align(Alignment.BottomCenter)) }
                }
            }
        }
        compose.runOnIdle { toaster.success("Saved") }
        compose.mainClock.advanceTimeBy(600)
        compose.onNodeWithText("Saved").assertIsDisplayed()
        assertEquals(Tone.SUCCESS, toaster.current?.tone)
        compose.mainClock.advanceTimeBy(2_600)
        compose.onNodeWithText("Saved").assertDoesNotExist()
        assertNull(toaster.current)

        // Danger stays 4 s, and a new toast replaces the one on screen.
        compose.runOnIdle { toaster.toast("Queued") }
        compose.mainClock.advanceTimeBy(300)
        compose.runOnIdle { toaster.error(ApiError(500, "boom"), what = "jobs") }
        compose.mainClock.advanceTimeBy(900)
        compose.onNodeWithText("Queued").assertDoesNotExist()
        compose.onNodeWithText("Couldn't load jobs — the server hit an error.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(2_500)
        compose.onNodeWithText("Couldn't load jobs — the server hit an error.").assertIsDisplayed()
        compose.mainClock.advanceTimeBy(1_500)
        compose.onNodeWithText("Couldn't load jobs — the server hit an error.").assertDoesNotExist()
    }

    @Test
    fun detachedToasterIgnoresCalls() {
        Toaster.Detached.success("nothing")
        assertNull(Toaster.Detached.current)
    }

    @Test
    fun composerSendsTrimmedTextAndClears() {
        val sent = mutableListOf<String>()
        compose.setContent { OptioTheme { ChatComposer(onSend = { sent += it }) } }
        compose.onNodeWithTag("composer-send").assertIsNotEnabled()
        compose.onNodeWithTag("composer-field").performTextInput("  ship it  ")
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitForIdle()
        assertEquals(listOf("ship it"), sent)
        compose.onNodeWithTag("composer-field").assert(SemanticsMatcher.expectValue(SemanticsProperties.EditableText, AnnotatedString("")))
        compose.onNodeWithTag("composer-send").assertIsNotEnabled()
    }

    @Test
    fun statStripAndChipsReportSelection() {
        var tile: String? = null
        var chip = "all"
        compose.setContent {
            OptioTheme {
                Column {
                    StatStrip(listOf(StatItem("Running", 3), StatItem("Needs you", 2, Tone.ACCENT)), onSelect = { tile = it.key })
                    ChipPicker(listOf("all" to "All", "failed" to "Failed"), selection = chip, onSelect = { chip = it })
                }
            }
        }
        compose.onNodeWithTag("stat-Needs you").performClick()
        compose.onNodeWithTag("chip-Failed").performClick()
        compose.runOnIdle {
            assertEquals("Needs you", tile)
            assertEquals("failed", chip)
        }
    }

    @Test
    fun serverSwitcherListsServersAndSwitches() {
        val a = ServerOption("a", "mbp", "mbp.tail.ts.net", Color.Blue)
        val b = ServerOption("b", "studio", "studio.tail.ts.net", Color.Green)
        val events = mutableListOf<String>()
        compose.setContent {
            OptioTheme {
                ServerSwitcherChip(
                    active = a,
                    servers = listOf(a, b),
                    onSwitch = { events += "switch:$it" },
                    onAddServer = { events += "add" },
                    onManageServers = { events += "manage" },
                )
            }
        }
        compose.onNodeWithTag("server-switcher").performClick()
        compose.onNodeWithText("studio.tail.ts.net").assertIsDisplayed()
        compose.onNodeWithTag("server-b").performClick()
        compose.onNodeWithTag("server-switcher").performClick()
        compose.onNodeWithTag("server-a").performClick() // the active one: no switch
        compose.onNodeWithTag("server-switcher").performClick()
        compose.onNodeWithTag("manage-servers").performClick()
        compose.runOnIdle { assertEquals(listOf("switch:b", "manage"), events) }
    }

    @Test
    fun toolCallsExpandToShowTheirBodyAndResult() {
        compose.setContent { OptioTheme { AgentLogView(Samples.transcript(), autoScroll = false) } }
        compose.onNodeWithText("8 passed, 2 failed (login.spec.ts:24 timed out)").assertDoesNotExist()
        compose.onNodeWithTag("log-row-3").performClick()
        compose.onNodeWithText("8 passed, 2 failed (login.spec.ts:24 timed out)").assertIsDisplayed()
    }

    @Test
    fun confirmStateAsksThenActs() {
        var killed = 0
        compose.setContent {
            OptioTheme {
                val confirm = rememberConfirmState()
                Button(onClick = { confirm.ask("Kill this terminal?", "The process is stopped.", "Kill", destructive = true) { killed++ } }) {
                    Text("Kill")
                }
                ConfirmHost(confirm)
            }
        }
        compose.onNodeWithText("Kill").performClick()
        compose.onNodeWithText("Kill this terminal?").assertIsDisplayed()
        compose.onNodeWithTag("dismiss").performClick()
        compose.onNodeWithTag("confirm-dialog").assertDoesNotExist()
        compose.onNodeWithText("Kill").performClick()
        compose.onNodeWithTag("confirm").performClick()
        compose.runOnIdle { assertEquals(1, killed) }
        compose.onNodeWithTag("confirm-dialog").assertDoesNotExist()
    }

    @Test
    fun loadableShowsSkeletonErrorThenContent() {
        var state by mutableStateOf<LoadState<String>>(LoadState.Loading())
        var retries = 0
        compose.setContent {
            OptioTheme {
                Loadable(state = state, onRetry = { retries++ }, what = "jobs") { value -> Text("value: $value") }
            }
        }
        compose.onNodeWithTag("skeleton").assertIsDisplayed()
        state = LoadState.Failed(ApiError(502, "Bad Gateway"))
        compose.onNodeWithText("Couldn't load jobs — the server hit an error.").assertIsDisplayed()
        compose.onNodeWithTag("retry").performClick()
        compose.runOnIdle { assertEquals(1, retries) }
        state = LoadState.Loaded("a")
        compose.onNodeWithText("value: a").assertIsDisplayed()
        // A failed refresh keeps the value on screen.
        state = LoadState.Failed(ApiError(502, "Bad Gateway"), previous = "a")
        compose.onNodeWithText("value: a").assertIsDisplayed()
    }

    @Test
    fun loadableRunsItsOwnLoader() {
        var calls = 0
        compose.setContent {
            OptioTheme {
                Loadable(load = { calls++; "loaded $calls" }) { value -> Text(value) }
            }
        }
        compose.onNodeWithText("loaded 1").assertIsDisplayed()
    }

    @Test
    fun observingBindsTheStoreToTheActiveClientAndFetches() {
        server.server.fixture("/api/auth/usage", "auth-usage.json")
        server.server.fixture("/api/local/hosts", "local-hosts.json")
        val api = server.server.client()
        lateinit var store: UsageStore
        compose.setContent {
            store = rememberUsageStore()
            CompositionLocalProvider(LocalUsageStore provides store, LocalApiClient provides api) {
                OptioTheme { ObservesUsage() }
            }
        }
        server.server.awaitRequest("GET", "/api/auth/usage")
        compose.waitUntil(timeoutMillis = 5_000) { store.usage != null }
        assertEquals(1, store.viewerCount)
        assertTrue(store.claudeBuckets.isNotEmpty())
    }

    @Test
    fun detailHeaderShowsThePillOnlyWithNumbers() {
        compose.setContent {
            CompositionLocalProvider(LocalUsageStore provides UsageSamples.store()) {
                OptioTheme { DetailHeader(state = "running", secondary = metaText(mono("/Users/dev/web")), showsUsage = true) }
            }
        }
        compose.onNodeWithTag("usage-pill").assertIsDisplayed()
        compose.onNodeWithText("RUNNING").assertIsDisplayed()
    }
}
