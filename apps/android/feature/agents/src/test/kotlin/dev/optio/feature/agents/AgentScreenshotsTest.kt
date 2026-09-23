package dev.optio.feature.agents

import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import dev.optio.core.model.PersistentAgentState
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import org.junit.Test

/**
 * Every agent screen, light and dark (`./gradlew :feature:agents:recordRoborazziDebug` writes
 * `build/outputs/roborazzi/Agent*_light|dark.png`).
 */
class AgentScreenshotsTest : ScreenshotTest() {
    @Test
    fun chat() =
        captureScreens("AgentChat") {
            AgentDetailContent(ui = AgentSamples.ui(), actions = AgentDetailActions.None)
        }

    @Test
    fun chatPausedWithAFailure() =
        captureScreens("AgentChat_paused") {
            val ui = AgentSamples.ui(state = PersistentAgentState.PAUSED, pending = 0, live = AgentLiveTail(), connected = false)
            val agent = ui.agent!!.copy(consecutiveFailures = 2.0, lastFailureReason = "Agent exited with code 1: rate limited")
            AgentDetailContent(
                ui = ui.copy(header = LoadState.Loaded(AgentHeader(agent))),
                actions = AgentDetailActions.None,
            )
        }

    @Test
    fun chatEmpty() =
        captureScreens("AgentChat_empty") {
            AgentDetailContent(
                ui = AgentSamples.ui(pending = 0, live = AgentLiveTail()).copy(messages = LoadState.Loaded(emptyList())),
                actions = AgentDetailActions.None,
            )
        }

    @Test
    fun loading() =
        captureScreens("AgentDetail_loading") {
            AgentDetailContent(ui = AgentDetailUi(), actions = AgentDetailActions.None)
        }

    @Test
    fun failed() =
        captureScreens("AgentDetail_error") {
            AgentDetailContent(
                ui = AgentDetailUi(header = LoadState.Failed(dev.optio.core.network.ApiError(404, "Not found"))),
                actions = AgentDetailActions.None,
            )
        }

    @Test
    fun turns() =
        captureScreens("AgentTurns") {
            AgentDetailContent(ui = AgentSamples.ui(), actions = AgentDetailActions.None, initialSection = AgentSection.TURNS)
        }

    @Test
    fun triggers() =
        captureScreens("AgentTriggers", size = ScreenSize.TALL) {
            AgentDetailContent(ui = AgentSamples.ui(), actions = AgentDetailActions.None, initialSection = AgentSection.TRIGGERS)
        }

    @Test
    fun config() =
        captureScreens("AgentConfig", size = ScreenSize.TALL) {
            AgentDetailContent(ui = AgentSamples.ui(), actions = AgentDetailActions.None, initialSection = AgentSection.CONFIG)
        }

    @Test
    fun menu() =
        captureScreens("AgentMenu", wholeScreen = true, interact = { onNodeWithTag("agent-menu").performClick() }) {
            AgentDetailContent(ui = AgentSamples.ui(), actions = AgentDetailActions.None)
        }

    @Test
    fun turn() =
        captureScreens("AgentTurn") {
            AgentTurnContent(AgentSamples.turnDetail, AgentSamples.ID)
        }

    @Test
    fun turnWithPrompt() =
        captureScreens("AgentTurn_prompt", interact = { onNodeWithTag("prompt-used").performClick() }) {
            AgentTurnContent(AgentSamples.turnDetail, AgentSamples.ID)
        }

    @Test
    fun newAgentForm() =
        captureScreens("AgentForm_new", size = ScreenSize.TALL) {
            AgentFormContent(
                editing = false,
                agent = LoadState.Loaded(null),
                draft = AgentFormDraft(slug = "release-captain", name = "Release Captain"),
                saving = false,
                error = null,
                onChange = {},
                onRetry = {},
                onCancel = {},
                onSave = {},
            )
        }

    @Test
    fun editAgentForm() =
        captureScreens("AgentForm_edit", size = ScreenSize.TALL) {
            val agent = AgentSamples.agent()
            AgentFormContent(
                editing = true,
                agent = LoadState.Loaded(agent),
                draft = AgentFormDraft.from(agent),
                saving = false,
                error = dev.optio.core.network.ApiError(409, "Slug \"release-captain\" already exists"),
                onChange = {},
                onRetry = {},
                onCancel = {},
                onSave = {},
            )
        }

    @Test
    fun triggerSheetSchedule() = sheet("AgentTriggerSheet_schedule", AgentTriggerDraft(webhookPath = "hook-7f3kq2ma"))

    @Test
    fun triggerSheetGitHub() = sheet("AgentTriggerSheet_github", AgentTriggerDraft(type = AgentTriggerType.GITHUB))

    @Test
    fun triggerSheetSlack() =
        sheet("AgentTriggerSheet_slack", AgentTriggerDraft(type = AgentTriggerType.SLACK, slackChannel = "C0RELEASES", slackMentionOnly = true))

    @Test
    fun triggerSheetTicket() =
        sheet("AgentTriggerSheet_ticket", AgentTriggerDraft(type = AgentTriggerType.TICKET, ticketSource = "linear", ticketLabels = listOf("release", "docs")))

    private fun sheet(name: String, draft: AgentTriggerDraft) =
        captureScreens(name) {
            Surface(color = MaterialTheme.colorScheme.surfaceContainerLow, modifier = Modifier.fillMaxWidth()) {
                AgentTriggerForm(draft = draft, onChange = {}, saving = false, onCancel = {}, onCreate = {})
            }
        }
}
