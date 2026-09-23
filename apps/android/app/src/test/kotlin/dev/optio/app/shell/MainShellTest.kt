package dev.optio.app.shell

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.assertIsSelected
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.Tab
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.ui.theme.OptioTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/** The scaffold's shell under Robolectric: tabs, hubs, sections, the hub slot API, back stacks. */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class MainShellTest {
    @get:Rule
    val compose = createComposeRule()

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    @After
    fun tearDown() = scope.cancel()

    @Test
    fun tabsSectionsAndDetailsNavigate() {
        // Drives navigation through the router and the shell's own tags only (tab-*, hub-*,
        // section-*), so the feature screens behind the routes can change freely.
        val session = SessionStore(ServerRegistry.inMemory(), scope)
        val router = AppRouter()
        compose.setContent {
            CompositionLocalProvider(LocalSessionStore provides session) {
                OptioTheme { MainShell(router = router) }
            }
        }
        compose.onNodeWithTag("hub-overview").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/MainShell_overview.png")

        // Library › Repos via the bar and the segmented switcher.
        compose.onNodeWithTag("tab-library").performClick()
        compose.onNodeWithTag("section-repos").performClick()
        compose.onNodeWithTag("hub-library").assertIsDisplayed()
        compose.onNodeWithTag("section-repos").assertIsSelected()

        // A detail pushes onto the Library stack and covers the hub; popping returns to it.
        compose.runOnIdle { router.push(RepoDetailRoute("sample-repo"), Tab.LIBRARY) }
        compose.onNodeWithTag("hub-library").assertDoesNotExist()
        compose.runOnIdle { router.pop(Tab.LIBRARY) }
        compose.onNodeWithTag("hub-library").assertIsDisplayed()

        // Each tab keeps its own stack: a detail on Work survives a trip to Library and back…
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("hub-work").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/MainShell_work.png")
        compose.runOnIdle { router.push(NewWorkRoute(), Tab.WORK) }
        compose.onNodeWithTag("hub-work").assertDoesNotExist()
        compose.onNodeWithTag("tab-library").performClick()
        compose.onNodeWithTag("hub-library").assertIsDisplayed()
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("hub-work").assertDoesNotExist()
        compose.runOnIdle { assertEquals(2, router.backStack(Tab.WORK).size) }
        // …and re-selecting the tab on screen pops it to its hub.
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("hub-work").assertIsDisplayed()

        // Cross-tab: opening Library › Machines selects that tab and section.
        compose.onNodeWithTag("tab-overview").performClick()
        compose.runOnIdle { router.open(Section.MACHINES) }
        compose.onNodeWithTag("hub-library").assertIsDisplayed()
        compose.onNodeWithTag("section-machines").assertIsSelected()
    }
}
