package dev.optio.feature.agents

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsFocused
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.glance.NotificationSubject
import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.AgentFormRoute
import dev.optio.core.navigation.routes.AgentTurnRoute
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.Samples
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The agent screen's interactions: focus from the deep link, role gating, chips, confirmations. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class AgentDetailUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val pushed = mutableListOf<NavKey>()
    private val navigator =
        object : Navigator {
            override fun push(route: NavKey) {
                pushed += route
            }

            override fun pop() = Unit

            override fun open(section: Section, view: WorkView?) = Unit

            override fun openExternal(url: String) = Unit
        }

    private class Recorder : AgentDetailActions by AgentDetailActions.None {
        val sent = mutableListOf<String>()
        val intents = mutableListOf<PersistentAgentControlIntent>()
        var deleted = false

        override suspend fun send(body: String): Boolean {
            sent += body
            return true
        }

        override fun control(intent: PersistentAgentControlIntent) {
            intents += intent
        }

        override fun delete() {
            deleted = true
        }
    }

    private fun show(
        ui: () -> AgentDetailUi,
        actions: AgentDetailActions = AgentDetailActions.None,
        focusComposer: Boolean = false,
        user: CurrentUser? = null,
    ) {
        compose.setContent {
            CompositionLocalProvider(LocalNavigator provides navigator, LocalCurrentUser provides user) {
                OptioTheme(darkTheme = false) {
                    AgentDetailContent(ui = ui(), actions = actions, focusComposer = focusComposer)
                }
            }
        }
    }

    @Test
    fun theDeepLinkFocusesTheComposerOnceTheAgentHasLoaded() {
        var ui by mutableStateOf(AgentDetailUi())
        show({ ui }, focusComposer = true)
        // Loading: the field is disabled (a disabled field can't hold focus).
        compose.onNodeWithTag("composer-field").assertIsNotEnabled()
        compose.runOnIdle { ui = AgentSamples.ui() }
        compose.onNodeWithTag("composer-field").assertIsFocused()
    }

    @Test
    fun sendingGoesThroughTheActions() {
        val actions = Recorder()
        show({ AgentSamples.ui() }, actions)
        compose.onNodeWithTag("composer-field").performTextInput("Draft the changelog")
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitUntil { actions.sent.isNotEmpty() }
        assertEquals(listOf("Draft the changelog"), actions.sent)
    }

    @Test
    fun viewersGetNoComposerAndNoActions() {
        show({ AgentSamples.ui() }, user = Samples.currentUser(role = CurrentUser.ROLE_VIEWER))
        compose.onNodeWithTag("composer-field").assertDoesNotExist()
        compose.onNodeWithTag("agent-menu").assertDoesNotExist()
        compose.onNodeWithTag("tab-Triggers").performClick()
        compose.onNodeWithTag("add-trigger").assertDoesNotExist()
        compose.onNodeWithTag("delete-trigger").assertDoesNotExist()
    }

    @Test
    fun chipsSwitchAndTurnsOpenTheirDetail() {
        show({ AgentSamples.ui() })
        compose.onNodeWithTag("tab-Turns").performClick()
        compose.onNodeWithTag("turn-6").performClick()
        assertEquals(AgentTurnRoute(AgentSamples.ID, "turn-6", 6), pushed.single())
        compose.onNodeWithTag("tab-Config").performClick()
        compose.onNodeWithTag("edit-agent").performClick()
        assertEquals(AgentFormRoute(AgentSamples.ID), pushed.last())
    }

    @Test
    fun archiveAndDeleteAskFirst() {
        val actions = Recorder()
        show({ AgentSamples.ui() }, actions)
        compose.onNodeWithTag("agent-menu").performClick()
        compose.onNodeWithText("Archive").performClick()
        compose.onNodeWithText("Archive this agent?").assertExists()
        compose.onNodeWithTag("confirm").performClick()
        assertEquals(listOf(PersistentAgentControlIntent.ARCHIVE), actions.intents)

        compose.onNodeWithTag("agent-menu").performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithTag("dismiss").performClick()
        assertEquals(false, actions.deleted)
        compose.onNodeWithTag("agent-menu").performClick()
        compose.onNodeWithText("Delete").performClick()
        compose.onNodeWithTag("confirm").performClick()
        assertEquals(true, actions.deleted)
    }

    @Test
    fun theAgentOnScreenIsTheNotificationSubject() {
        var shown by mutableStateOf(true)
        compose.setContent {
            CompositionLocalProvider(LocalNavigator provides navigator) {
                OptioTheme(darkTheme = false) { if (shown) AgentDetailScreen(agentId = AgentSamples.ID) }
            }
        }
        compose.waitForIdle()
        assertTrue(NotificationSubject.isViewing("agent", AgentSamples.ID), "alerts about it post silently")
        compose.runOnIdle { shown = false }
        compose.waitForIdle()
        assertFalse(NotificationSubject.isViewing("agent", AgentSamples.ID))
    }

    @Test
    fun theMenuOffersResumeForAPausedAgent() {
        val actions = Recorder()
        show({ AgentSamples.ui(state = dev.optio.core.model.PersistentAgentState.PAUSED) }, actions)
        compose.onNodeWithTag("agent-menu").performClick()
        compose.onNodeWithText("Pause").assertDoesNotExist()
        compose.onNodeWithText("Resume").performClick()
        assertEquals(listOf(PersistentAgentControlIntent.RESUME), actions.intents)
    }
}
