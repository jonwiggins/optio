package dev.optio.app.shell

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.ui.theme.OptioTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import org.junit.After
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
        // Hubs read the session (server switcher); an unpaired one shows no chip.
        val session = SessionStore(ServerRegistry.inMemory(), scope)
        compose.setContent {
            CompositionLocalProvider(LocalSessionStore provides session) {
                OptioTheme { MainShell() }
            }
        }
        compose.onNodeWithTag("hub-overview").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/MainShell_overview.png")

        // Library › Repos: a sample detail pushes onto the Library stack, Back pops it.
        compose.onNodeWithTag("tab-library").performClick()
        compose.onNodeWithTag("section-repos").performClick()
        compose.onNodeWithText("Push RepoDetailRoute(id=sample-repo)").performClick()
        compose.onNodeWithText("RepoDetailRoute(id=sample-repo)").assertIsDisplayed()
        compose.onNodeWithTag("back").performClick()
        compose.onNodeWithTag("hub-library").assertIsDisplayed()

        // The Repos section contributed a top-bar action through the hub slot API.
        compose.onNodeWithTag("add-repo").performClick()
        compose.onNodeWithText("Add repo").assertIsDisplayed()

        // Each tab keeps its own stack; re-selecting the tab on screen pops it to its hub.
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithTag("hub-work").assertIsDisplayed()
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/MainShell_work.png")
        compose.onNodeWithTag("new-work").performClick()
        compose.onNodeWithText("NewWorkRoute(preset=null)").assertIsDisplayed()
        compose.onNodeWithTag("tab-library").performClick()
        compose.onNodeWithText("NewRepoRoute").assertIsDisplayed()
        compose.onNodeWithTag("tab-library").performClick()
        compose.onNodeWithTag("hub-library").assertIsDisplayed()
        compose.onNodeWithTag("tab-work").performClick()
        compose.onNodeWithText("NewWorkRoute(preset=null)").assertIsDisplayed()

        // Cross-tab: Overview › "Open Library › Machines" lands on the Machines section.
        compose.onNodeWithTag("tab-overview").performClick()
        compose.onNodeWithTag("open-machines").performClick()
        compose.onNodeWithTag("hub-library").assertIsDisplayed()
        compose.onNodeWithText("Push LocalTerminalRoute(id=sample-terminal, compose=false)").assertIsDisplayed()
    }
}
