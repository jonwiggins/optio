package dev.optio.feature.tasks.job

import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelStore
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.tasks.fastSockets
import dev.optio.feature.tasks.make
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * A Job run on the user's machine keeps no pod logs: its Logs tab points at the Local session
 * (the web links the run to its terminal) instead of reading "No logs recorded".
 */
@RunWith(AndroidJUnit4::class)
class JobRunLocalTest {
    @get:Rule val fake = FakeOptioServerRule()

    @get:Rule val compose = createComposeRule()

    private val store = ViewModelStore()

    @AfterTest
    fun tearDown() = store.clear()

    private class RecordingNavigator : Navigator {
        val pushed = mutableListOf<NavKey>()

        override fun push(route: NavKey) {
            pushed += route
        }

        override fun pop() = Unit

        override fun open(section: Section, view: WorkView?) = Unit

        override fun openExternal(url: String) = Unit
    }

    @Test
    fun aLocalRunLinksToItsSession() {
        val run = Fixtures.text("run-completed.json").replace("\"localTerminalId\": null", "\"localTerminalId\": \"term-1\"")
        fake.server.json("/api/workflow-runs/:id", run)
        fake.server.json("/api/workflow-runs/:id/logs", """{"logs":[]}""")
        fake.server.fixture("/api/jobs/:id", "job-main.json")
        fake.server.webSocket("/ws/workflow-runs/:id/logs")
        val api = fake.server.client()
        val vm = store.make { JobRunViewModel(api, "j1", "r1", fastSockets(api)) }
        val nav = RecordingNavigator()
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalNavigator provides nav) { JobRunScreen(vm) }
            }
        }
        // The run loads on OkHttp's threads and resumes on the paused Robolectric main looper.
        val deadline = System.nanoTime() + 30.seconds.inWholeNanoseconds
        while (vm.state.value !is LoadState.Loaded || !vm.logs.loaded.value) {
            check(System.nanoTime() < deadline) { "never loaded: ${vm.state.value}" }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        compose.waitForIdle()

        compose.onNodeWithTag("banner-local").assertIsDisplayed()
        compose.onNodeWithText("Its output is in the session on your machine").assertIsDisplayed()
        compose.onNodeWithTag("open-terminal").performClick()
        assertEquals(listOf<NavKey>(LocalTerminalRoute("term-1")), nav.pushed)
    }
}
