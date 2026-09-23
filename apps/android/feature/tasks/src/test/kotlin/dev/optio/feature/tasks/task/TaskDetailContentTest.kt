package dev.optio.feature.tasks.task

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.assertCountEquals
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.Samples
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.feature.tasks.TaskSamples
import kotlin.test.Test
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.runner.RunWith

/** The task detail's controls: what each state and role shows, and that they call through. */
@RunWith(AndroidJUnit4::class)
class TaskDetailContentTest {
    @get:Rule val compose = createComposeRule()

    private fun show(detail: TaskDetail, actions: TaskDetailActions = TaskDetailActions(), viewer: Boolean = false, followed: Boolean = false, onFollow: (() -> Unit)? = {}) {
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalCurrentUser provides if (viewer) Samples.currentUser(role = "viewer") else null) {
                    TaskDetailContent(
                        state = LoadState.Loaded(detail),
                        logEntries = TaskSamples.prLogs,
                        logConnected = true,
                        logLoaded = true,
                        busy = false,
                        actions = actions,
                        followed = followed,
                        onToggleFollow = onFollow,
                    )
                }
            }
        }
    }

    @Test
    fun followToggleShowsForUnfinishedTasksOnly() {
        var toggles = 0
        show(TaskSamples.stalledRunning, onFollow = { toggles++ })
        compose.onNodeWithTag("follow").performClick()
        assertEquals(1, toggles)
        compose.onNodeWithTag("overflow").performClick()
        compose.onNodeWithText("Follow in Watch notification").performClick()
        assertEquals(2, toggles)
    }

    @Test
    fun noFollowOnAFinishedTask() {
        show(TaskSamples.completed)
        compose.onAllNodesWithTag("follow").assertCountEquals(0)
    }

    @Test
    fun theMenuOffersWhatTheStateAllows() {
        var retried = 0
        show(TaskSamples.failed, actions = TaskDetailActions(retry = { retried++ }))
        compose.onNodeWithTag("overflow").performClick()
        compose.onNodeWithText("Retry").assertExists()
        compose.onNodeWithText("Attempt resume").assertExists()
        compose.onAllNodesWithTag("action-cancel").assertCountEquals(0)
        compose.onAllNodesWithTag("action-review").assertCountEquals(0)
        compose.onNodeWithText("Retry").performClick()
        assertEquals(1, retried)
    }

    @Test
    fun destructiveActionsAskFirst() {
        var cancelled = 0
        show(TaskSamples.stalledRunning, actions = TaskDetailActions(cancel = { cancelled++ }))
        compose.onNodeWithTag("overflow").performClick()
        compose.onNodeWithText("Cancel task").performClick()
        compose.onNodeWithText("Cancel this task?").assertExists()
        assertEquals(0, cancelled)
        compose.onNodeWithTag("confirm").performClick()
        assertEquals(1, cancelled)
    }

    @Test
    fun viewersGetNoComposerAndOnlyRefresh() {
        show(TaskSamples.prOpened, viewer = true)
        compose.onAllNodesWithTag("task-composer").assertCountEquals(0)
        compose.onNodeWithTag("overflow").performClick()
        compose.onNodeWithText("Refresh").assertExists()
        compose.onAllNodesWithTag("action-review").assertCountEquals(0)
        compose.onAllNodesWithTag("action-force-redo").assertCountEquals(0)
    }

    @Test
    fun aRunningClaudeTaskOffersTheMessageMode() {
        show(TaskSamples.stalledRunning)
        compose.onNodeWithTag("message-mode").performClick()
        compose.onNodeWithText("Interrupt (stop current work)").performClick()
        compose.onNodeWithText("Interrupt (stop current work)").assertExists()
    }
}
