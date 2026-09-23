package dev.optio.app.shell

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.Tab
import dev.optio.core.navigation.routes.HubRoute
import dev.optio.core.navigation.routes.JobRunRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.core.ui.toast.ToastHost
import dev.optio.core.ui.toast.rememberToaster
import kotlin.test.assertEquals
import kotlin.test.assertNull
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The New work form's "done" (`Navigator.showCreatedWork` → `AppRouter.showCreatedWork`) in the
 * real shell, from the Work tab and from the Overview: the form closes, the created work's detail
 * lands on the Work tab, the shell's snackbar shows the confirmation, and Back returns to the Work
 * list (which refreshes as it reappears).
 */
@OptIn(ExperimentalTestApi::class)
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class CreatedWorkFlowTest {
    @get:Rule
    val compose = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val router = AppRouter()

    @After
    fun tearDown() = scope.cancel()

    private fun showShell() {
        val session = SessionStore(ServerRegistry.inMemory(), scope)
        compose.setContent {
            OptioTheme {
                val toaster = rememberToaster()
                CompositionLocalProvider(LocalSessionStore provides session, LocalToaster provides toaster) {
                    // As `OptioApp` lays them out: the shell, and one toast host over it.
                    Box(Modifier.fillMaxSize()) {
                        MainShell(router = router)
                        ToastHost(toaster, Modifier.align(Alignment.BottomCenter))
                    }
                }
            }
        }
    }

    @Test
    fun fromTheWorkListTheFormLandsOnTheDetailWithAToast() {
        showShell()
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("new-work").performClick()
        compose.runOnIdle { assertEquals(NewWorkRoute(), router.backStack(Tab.WORK).last()) }

        // What the form does once the server made the task.
        compose.runOnIdle { router.showCreatedWork(TaskDetailRoute("t1"), "Started Fix login") }
        compose.waitUntilAtLeastOneExists(hasTestTag("toast"), 5_000)
        compose.onNodeWithText("Started Fix login").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(Tab.WORK, router.selectedTab)
            assertEquals(listOf(HubRoute(Tab.WORK), TaskDetailRoute("t1")), router.backStack(Tab.WORK).toList(), "the form is gone")
            assertNull(router.createdToast, "the shell consumed the toast")
        }
        compose.onNodeWithTag("hub-work").assertDoesNotExist()

        // Back: the Work list again.
        compose.runOnIdle { router.pop() }
        compose.onNodeWithTag("hub-work").assertIsDisplayed()
        compose.onNodeWithTag("new-work").assertIsDisplayed()
    }

    @Test
    fun fromTheOverviewTheFormClosesThereAndTheDetailOpensOnWork() {
        showShell()
        compose.onNodeWithTag("overview-new-work").performClick()
        compose.runOnIdle { assertEquals(NewWorkRoute(), router.backStack(Tab.OVERVIEW).last()) }

        compose.runOnIdle { router.showCreatedWork(JobRunRoute(jobId = "j1", runId = "r1"), "Run started") }
        compose.waitUntilAtLeastOneExists(hasTestTag("toast"), 5_000)
        compose.onNodeWithText("Run started").assertIsDisplayed()
        compose.runOnIdle {
            assertEquals(Tab.WORK, router.selectedTab)
            assertEquals(listOf(HubRoute(Tab.OVERVIEW)), router.backStack(Tab.OVERVIEW).toList(), "the form left the Overview")
            assertEquals(JobRunRoute("j1", "r1"), router.backStack(Tab.WORK).last())
        }
    }
}
