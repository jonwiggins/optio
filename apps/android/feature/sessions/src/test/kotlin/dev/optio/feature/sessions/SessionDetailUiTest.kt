package dev.optio.feature.sessions

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.assertIsEnabled
import androidx.compose.ui.test.assertIsNotEnabled
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.model.InteractiveSession
import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.SessionPr
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.terminal.TerminalState
import dev.optio.core.testing.Samples
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The session screen's interactions: sending, the model menu, Stop, the chips, ending, PR links. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class SessionDetailUiTest {
    @get:Rule
    val compose = createComposeRule()

    private val opened = mutableListOf<String>()
    private val navigator =
        object : Navigator {
            override fun push(route: NavKey) = Unit

            override fun pop() = Unit

            override fun open(section: Section, view: WorkView?) = Unit

            override fun openExternal(url: String) {
                opened += url
            }
        }

    private class Recorder : SessionDetailActions by SessionDetailActions.None {
        val sent = mutableListOf<String>()
        val models = mutableListOf<String>()
        var interrupts = 0
        var ends = 0
        var shellOpened = 0

        override fun send(text: String): Boolean {
            sent += text
            return true
        }

        override fun setModel(model: String) {
            models += model
        }

        override fun interrupt() {
            interrupts++
        }

        override fun end() {
            ends++
        }

        override fun openShell() {
            shellOpened++
        }
    }

    private val session =
        InteractiveSession(
            id = "s1",
            repoUrl = "https://github.com/acme/web",
            branch = "session/dev/abc",
            title = "Investigate slow cold start",
            state = InteractiveSessionState.ACTIVE,
            createdAt = Samples.agoIso(30),
        )

    private val pr = SessionPr("p1", "s1", "https://github.com/acme/web/pull/77", 77.0, "open", "pending", "none", Samples.agoIso(5), Samples.agoIso(5))

    private fun ui(chat: SessionChatUi) =
        SessionDetailUi(
            session = LoadState.Loaded(SessionEnvelope(session, SessionModelConfig("sonnet", listOf("haiku", "sonnet", "opus")))),
            prs = listOf(pr),
            chat = chat,
        )

    private fun show(ui: () -> SessionDetailUi, actions: SessionDetailActions) {
        compose.setContent {
            CompositionLocalProvider(LocalNavigator provides navigator) {
                OptioTheme(darkTheme = false) {
                    SessionDetailContent(ui = ui(), terminal = { TerminalState() }, actions = actions)
                }
            }
        }
    }

    @Test
    fun theComposerWaitsUntilTheChatCanTakeAMessage() {
        val actions = Recorder()
        var chat by mutableStateOf(SessionChatUi(status = SessionChatConnection.READY, historyLoaded = true, settled = false))
        show({ ui(chat) }, actions)
        compose.onNodeWithTag("composer-field").assertIsNotEnabled()
        compose.onNodeWithText("connecting", substring = true).assertExists()

        compose.runOnIdle { chat = chat.copy(canSend = true, settled = true) }
        compose.onNodeWithTag("composer-field").assertIsEnabled()
        compose.onNodeWithTag("composer-field").performTextInput("Profile the cold start")
        compose.onNodeWithTag("composer-send").performClick()
        compose.waitUntil { actions.sent.isNotEmpty() }
        assertEquals(listOf("Profile the cold start"), actions.sent)
    }

    @Test
    fun theModelMenuAndStop() {
        val actions = Recorder()
        show({ ui(SessionChatUi(status = SessionChatConnection.THINKING, model = "sonnet", historyLoaded = true, settled = true)) }, actions)
        compose.onNodeWithTag("chat-model").performClick()
        compose.onNodeWithText("opus").performClick()
        assertEquals(listOf("opus"), actions.models)
        compose.onNodeWithTag("chat-interrupt").performClick()
        assertEquals(1, actions.interrupts)
    }

    @Test
    fun theTerminalChipOpensTheShellAndPrsOpenInTheBrowser() {
        val actions = Recorder()
        show({ ui(SessionChatUi(status = SessionChatConnection.IDLE, canSend = true, historyLoaded = true, settled = true)) }, actions)
        compose.onNodeWithTag("tab-Terminal").performClick()
        compose.waitUntil { actions.shellOpened == 1 }
        compose.onNodeWithTag("session-terminal").assertExists()
        compose.onNodeWithTag("tab-PRs (1)").performClick()
        compose.onNodeWithTag("pr-77").performClick()
        assertEquals(listOf("https://github.com/acme/web/pull/77"), opened)
    }

    @Test
    fun endingAsksFirst() {
        val actions = Recorder()
        show({ ui(SessionChatUi()) }, actions)
        compose.onNodeWithTag("session-menu").performClick()
        compose.onNodeWithText("End session").performClick()
        compose.onNodeWithText("End this session?").assertExists()
        compose.onNodeWithTag("dismiss").performClick()
        assertEquals(0, actions.ends)
        compose.onNodeWithTag("session-menu").performClick()
        compose.onNodeWithText("Open repo").performClick()
        assertTrue(opened.contains("https://github.com/acme/web"))
        compose.onNodeWithTag("session-menu").performClick()
        compose.onNodeWithText("End session").performClick()
        compose.onNodeWithTag("confirm").performClick()
        assertEquals(1, actions.ends)
    }

    @Test
    fun anEndedSessionHasNoChipsAndNoMenu() {
        show({ SessionDetailUi(session = LoadState.Loaded(SessionEnvelope(session.copy(state = InteractiveSessionState.ENDED, endedAt = Samples.agoIso(2))))) }, Recorder())
        compose.onNodeWithTag("session-ended").assertExists()
        compose.onNodeWithTag("tab-Chat").assertDoesNotExist()
        compose.onNodeWithTag("session-menu").assertDoesNotExist()
    }
}
