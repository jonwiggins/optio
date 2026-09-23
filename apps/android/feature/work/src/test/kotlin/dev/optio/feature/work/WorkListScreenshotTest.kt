package dev.optio.feature.work

import androidx.compose.runtime.remember
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTextInput
import dev.optio.core.navigation.WorkView
import dev.optio.core.network.ApiError
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenScope
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.workfeed.WorkFeed
import kotlinx.coroutines.awaitCancellation
import org.junit.Test

/**
 * Work › All against the DevLab seed, every view, light and dark, inside the hub's chrome
 * (`./gradlew :feature:work:recordRoborazziDebug` → `build/outputs/roborazzi/WorkList_*.png`).
 */
class WorkListScreenshotTest : ScreenshotTest() {
    private fun shot(
        name: String,
        view: WorkView,
        size: ScreenSize = ScreenSize.PHONE,
        load: suspend () -> WorkFeed.Sources = { WorkSeed.sources },
        interact: ScreenScope.() -> Unit = {},
    ) {
        captureScreens(name, size = size, clock = WorkSeed.clock, interact = interact) {
            // One ViewModel per capture: light and dark each start from the same state.
            val owner = remember { preloadedOwner(WorkListViewModel::class, WorkListViewModel(load = load, initialView = view)) }
            WithViewModels(owner) {
                TestWorkHub { padding -> WorkListSection(padding) }
            }
        }
    }

    @Test
    fun active() = shot("WorkList_active", WorkView.ACTIVE, ScreenSize.TALL)

    @Test
    fun recurring() = shot("WorkList_recurring", WorkView.RECURRING)

    @Test
    fun agents() = shot("WorkList_agents", WorkView.AGENTS)

    @Test
    fun history() = shot("WorkList_history", WorkView.HISTORY, ScreenSize.TALL)

    @Test
    fun all() = shot("WorkList_all", WorkView.ALL, ScreenSize.TALL)

    @Test
    fun loading() = shot("WorkList_loading", WorkView.ACTIVE, load = { awaitCancellation() })

    @Test
    fun unreachable() = shot("WorkList_error", WorkView.ACTIVE, load = { throw ApiError(0, "The server can't be reached.") })

    @Test
    fun emptyAgents() = shot("WorkList_empty", WorkView.AGENTS, load = { WorkFeed.Sources() })

    @Test
    fun search() =
        shot("WorkList_search", WorkView.ALL) {
            onNodeWithTag("work-search-toggle").performClick()
            onNodeWithTag("work-search").performTextInput("config")
        }

    @Test
    fun searchWithoutMatches() =
        shot("WorkList_noMatches", WorkView.RECURRING) {
            onNodeWithTag("work-search-toggle").performClick()
            onNodeWithTag("work-search").performTextInput("zebra")
        }
}
