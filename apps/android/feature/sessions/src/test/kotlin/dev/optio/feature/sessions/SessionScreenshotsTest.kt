package dev.optio.feature.sessions

import androidx.compose.runtime.remember
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.InteractiveSession
import dev.optio.core.model.InteractiveSessionState
import dev.optio.core.model.SessionPr
import dev.optio.core.terminal.TerminalSamples
import dev.optio.core.terminal.TerminalState
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import org.junit.Test

/**
 * The pod session screen, light and dark (`./gradlew :feature:sessions:recordRoborazziDebug` writes
 * `build/outputs/roborazzi/Session*_light|dark.png`).
 */
class SessionScreenshotsTest : ScreenshotTest() {
    private val session =
        InteractiveSession(
            id = "d95d4894-5728-4125-8700-fca98c9a2166",
            repoUrl = "https://github.com/acme/web",
            worktreePath = "/workspace/sessions/fb812229",
            branch = "session/dev/fb812229",
            title = "Investigate slow cold start",
            state = InteractiveSessionState.ACTIVE,
            podId = "pod-1",
            costUsd = "0.0123",
            createdAt = Samples.agoIso(34),
        )

    private val models = SessionModelConfig(claudeModel = "sonnet", availableModels = listOf("haiku", "sonnet", "opus"))

    private val prs =
        listOf(
            SessionPr("pr1", session.id, "https://github.com/acme/web/pull/77", 77.0, "open", "pending", "none", Samples.agoIso(12), Samples.agoIso(3)),
            SessionPr("pr2", session.id, "https://github.com/acme/web/pull/74", 74.0, "merged", "passing", "approved", Samples.agoIso(30), Samples.agoIso(20)),
            SessionPr("pr3", session.id, "https://github.com/acme/web/pull/71", 71.0, "closed", "failing", "changes_requested", Samples.agoIso(33), Samples.agoIso(31)),
        )

    private val rows: List<SessionChatRow> =
        buildList {
            add(SessionChatRow.User("u1", "Profile the app's cold start and list the three slowest steps."))
            Samples.transcript().drop(2).forEachIndexed { i, entry -> add(SessionChatRow.Entry("e$i", entry)) }
            add(SessionChatRow.User("u2", "Open a PR with the fix."))
            add(SessionChatRow.Entry("e-last", Samples.logEntry(AgentLogEntry.TypeValue.TEXT, "Opened [acme/web#77](https://github.com/acme/web/pull/77).", minutesAgo = 3)))
        }

    private fun ui(
        chat: SessionChatUi = SessionChatUi(rows, SessionChatConnection.IDLE, "sonnet", 0.0246, null, canSend = true, settled = true, historyLoaded = true),
        terminal: SessionTerminalUi = SessionTerminalUi(connected = true),
        session: InteractiveSession = this.session,
        prs: List<SessionPr> = this.prs,
    ) = SessionDetailUi(
        session = LoadState.Loaded(SessionEnvelope(session, models)),
        prs = prs,
        chat = chat,
        terminal = terminal,
    )

    @Test
    fun chat() =
        captureScreens("SessionChat") {
            SessionDetailContent(ui = ui(), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }

    @Test
    fun chatThinking() =
        captureScreens("SessionChat_thinking") {
            val chat = SessionChatUi(rows.take(4), SessionChatConnection.THINKING, "opus", 0.0123, "Agent is already processing a request", canSend = false, settled = true, historyLoaded = true)
            SessionDetailContent(ui = ui(chat = chat), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }

    @Test
    fun chatConnecting() =
        captureScreens("SessionChat_connecting") {
            val chat = SessionChatUi(emptyList(), SessionChatConnection.CONNECTING, historyLoaded = true)
            SessionDetailContent(ui = ui(chat = chat, prs = emptyList()), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }

    @Test
    fun modelMenu() =
        captureScreens("SessionChat_models", wholeScreen = true, interact = { onNodeWithTag("chat-model").performClick() }) {
            SessionDetailContent(ui = ui(), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }

    @Test
    fun terminal() {
        var shell: TerminalState? = null
        captureScreens(
            "SessionTerminal",
            interact = {
                waitForIdle()
                val state = shell!!
                state.feed(TerminalSamples.shell(lines = 40))
                waitForIdle()
            },
        ) {
            val state = remember { TerminalState().also { shell = it } }
            SessionDetailContent(
                ui = ui(),
                terminal = { state },
                actions = SessionDetailActions.None,
                initialSection = SessionSection.TERMINAL,
            )
        }
    }

    @Test
    fun terminalGaveUp() {
        var shell: TerminalState? = null
        captureScreens(
            "SessionTerminal_error",
            interact = {
                waitForIdle()
                shell!!.feed("\r\n\u001b[31mSession pod was cleaned up due to inactivity.\u001b[0m\r\n\r\n[disconnected]\r\n")
                waitForIdle()
            },
        ) {
            val state = remember { TerminalState().also { shell = it } }
            SessionDetailContent(
                ui =
                    ui(
                        terminal =
                            SessionTerminalUi(
                                connected = false,
                                error = "Session pod was cleaned up due to inactivity. Please end this session and start a new one.",
                                stopped = true,
                            ),
                    ),
                terminal = { state },
                actions = SessionDetailActions.None,
                initialSection = SessionSection.TERMINAL,
            )
        }
    }

    @Test
    fun prs() =
        captureScreens("SessionPrs") {
            SessionDetailContent(ui = ui(), terminal = { TerminalState() }, actions = SessionDetailActions.None, initialSection = SessionSection.PRS)
        }

    @Test
    fun noPrs() =
        captureScreens("SessionPrs_empty") {
            SessionDetailContent(ui = ui(prs = emptyList()), terminal = { TerminalState() }, actions = SessionDetailActions.None, initialSection = SessionSection.PRS)
        }

    @Test
    fun ended() =
        captureScreens("SessionEnded") {
            val ended = session.copy(state = InteractiveSessionState.ENDED, endedAt = Samples.agoIso(5), costUsd = "0.0842")
            SessionDetailContent(
                ui = ui(session = ended, chat = SessionChatUi()),
                terminal = { TerminalState() },
                actions = SessionDetailActions.None,
            )
        }

    @Test
    fun menu() =
        captureScreens("SessionMenu", wholeScreen = true, interact = { onNodeWithTag("session-menu").performClick() }) {
            SessionDetailContent(ui = ui(), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }

    @Test
    fun loading() =
        captureScreens("SessionDetail_loading") {
            SessionDetailContent(ui = SessionDetailUi(), terminal = { TerminalState() }, actions = SessionDetailActions.None)
        }
}
