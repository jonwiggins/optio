package dev.optio.feature.tasks

import android.os.Looper
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.lifecycle.ViewModelStore
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.JobFormRoute
import dev.optio.core.navigation.routes.ScheduledFormRoute
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.tasks.job.JobDetailScreen
import dev.optio.feature.tasks.job.JobDetailViewModel
import dev.optio.feature.tasks.scheduled.ScheduledDetailScreen
import dev.optio.feature.tasks.scheduled.ScheduledDetailViewModel
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.time.Duration.Companion.seconds
import org.junit.Rule
import org.junit.runner.RunWith
import org.robolectric.Shadows.shadowOf

/**
 * Recurring work is edited in the one Work form (web `/work/:id/edit`): a Job's and a scheduled
 * Task's Edit push `EditWorkRoute`; the per-kind settings forms stay one item below.
 */
@RunWith(AndroidJUnit4::class)
class EditRoutesTest {
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

    /**
     * Waits for the page's first load. The requests finish on OkHttp's threads and resume on the
     * (paused) Robolectric main looper, which `compose.waitUntil` doesn't run, so idle it here.
     */
    private fun awaitLoaded(state: () -> LoadState<*>) {
        val deadline = System.nanoTime() + 30.seconds.inWholeNanoseconds
        while (state() !is LoadState.Loaded) {
            if (System.nanoTime() > deadline) {
                throw AssertionError("never loaded: ${state()}; requests: ${fake.server.requests.map { "${it.method} ${it.path}" }}")
            }
            shadowOf(Looper.getMainLooper()).idle()
            Thread.sleep(10)
        }
        compose.waitForIdle()
    }

    private fun pickFromMenu(tag: String) {
        compose.onNodeWithTag("overflow").performClick()
        compose.onNodeWithTag(tag).performClick()
        compose.waitForIdle()
    }

    @Test
    fun jobEditOpensTheWorkForm() {
        fake.server.fixture("/api/jobs/:id", "job-main.json")
        // No active runs, so the page doesn't start its 5 s poll.
        fake.server.json("/api/jobs/:id/runs", """{"runs":[]}""")
        fake.server.fixture("/api/jobs/:id/triggers", "job-webhook-triggers.json")
        val vm = store.make { JobDetailViewModel(fake.server.client(), "j1") }
        val nav = RecordingNavigator()
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalNavigator provides nav) { JobDetailScreen(vm, baseUrl = null) }
            }
        }
        awaitLoaded { vm.state.value }

        pickFromMenu("action-edit")
        pickFromMenu("action-edit-settings")
        assertEquals(listOf<NavKey>(EditWorkRoute("j1"), JobFormRoute("j1")), nav.pushed)
    }

    @Test
    fun scheduledEditOpensTheWorkForm() {
        fake.server.fixture("/api/task-configs/:id", "scheduled.json")
        fake.server.fixture("/api/task-configs/:id/triggers", "scheduled-triggers.json")
        fake.server.fixture("/api/tasks/:id/runs", "scheduled-runs.json")
        val vm = store.make { ScheduledDetailViewModel(fake.server.client(), "c1") }
        val nav = RecordingNavigator()
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalNavigator provides nav) { ScheduledDetailScreen(vm, baseUrl = null) }
            }
        }
        awaitLoaded { vm.state.value }

        pickFromMenu("action-edit")
        pickFromMenu("action-edit-settings")
        assertEquals(listOf<NavKey>(EditWorkRoute("c1"), ScheduledFormRoute("c1")), nav.pushed)
    }
}
