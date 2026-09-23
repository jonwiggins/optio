package dev.optio.feature.work

import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.snapshots.Snapshot
import androidx.compose.ui.semantics.SemanticsActions
import androidx.compose.ui.test.assertIsDisplayed
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithTag
import androidx.compose.ui.test.onFirst
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import androidx.compose.ui.test.performSemanticsAction
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.Samples
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.workfeed.WorkFeed
import kotlin.test.assertEquals
import kotlin.test.assertNull
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The section's wiring: pending views, row / PR / FAB / empty-state navigation, search. */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class WorkListSectionTest {
    @get:Rule
    val compose = createComposeRule()

    private class RecordingNavigator : Navigator {
        val pushed = mutableListOf<NavKey>()
        val external = mutableListOf<String>()

        override fun push(route: NavKey) {
            pushed += route
        }

        override fun pop() = Unit

        override fun open(section: Section, view: WorkView?) = Unit

        override fun openExternal(url: String) {
            external += url
        }
    }

    private val navigator = RecordingNavigator()

    private fun show(
        router: AppRouter = AppRouter(),
        load: suspend () -> WorkFeed.Sources = { WorkSeed.sources },
        initialView: WorkView = WorkView.ACTIVE,
        user: CurrentUser? = null,
    ): WorkListViewModel {
        val vm = WorkListViewModel(load = load, initialView = initialView)
        val owner = preloadedOwner(WorkListViewModel::class, vm)
        compose.setContent {
            OptioTheme(darkTheme = false) {
                CompositionLocalProvider(LocalClock provides WorkSeed.clock, LocalCurrentUser provides user) {
                    WithViewModels(owner) {
                        TestWorkHub(router = router, navigator = navigator) { padding -> WorkListSection(padding) }
                    }
                }
            }
        }
        compose.waitForIdle()
        return vm
    }

    @Test
    fun aPendingViewFromTheRouterIsSelectedAndCleared() {
        val router = AppRouter()
        router.open(Section.WORK, WorkView.RECURRING)
        val vm = show(router)
        compose.waitUntil(5_000) { router.pendingWorkView == null }
        assertEquals(WorkView.RECURRING, vm.view.value)
        compose.onNodeWithText("Weekly dependency bump").assertIsDisplayed()

        // Later deep links (optio://section/work?view=agents) land while the list is on screen.
        compose.runOnIdle { Snapshot.withMutableSnapshot { router.openWork(WorkView.AGENTS) } }
        compose.waitUntil(5_000) { vm.view.value == WorkView.AGENTS }
        assertNull(router.pendingWorkView)
        compose.onNodeWithText("Release Captain").assertIsDisplayed()
    }

    @Test
    fun rowsOpenTheirDetailAndThePrChipOpensThePullRequest() {
        show()
        compose.onNodeWithText("Tidy up the config loader").performClick()
        assertEquals(TaskDetailRoute("47d85b88-e286-4b82-b6ba-6b2755aa1ff8"), navigator.pushed.last())

        compose.onNodeWithTag("work-list").performScrollToNode(hasTestTag("work-row-agent-56bdf662-094b-42c0-85b3-df3628f95428"))
        compose.onNodeWithTag("work-row-agent-56bdf662-094b-42c0-85b3-df3628f95428").performSemanticsAction(SemanticsActions.OnClick)
        assertEquals(AgentDetailRoute("56bdf662-094b-42c0-85b3-df3628f95428"), navigator.pushed.last())

        compose.onNodeWithTag("work-list").performScrollToNode(hasTestTag("work-row-pr"))
        // The FAB may cover a row scrolled to the bottom edge: click through semantics, not a touch.
        compose.onAllNodesWithTag("work-row-pr").onFirst().performSemanticsAction(SemanticsActions.OnClick)
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/4", navigator.external.single())
    }

    @Test
    fun theFabAndTheEmptyStateStartNewWork() {
        show(load = { WorkFeed.Sources() })
        compose.onNodeWithTag("new-work").performClick()
        assertEquals(NewWorkRoute(), navigator.pushed.single())
        compose.onNodeWithText("Nothing needs you right now").assertIsDisplayed()
        compose.onNodeWithTag("empty-state-action").performClick()
        assertEquals(listOf<NavKey>(NewWorkRoute(), NewWorkRoute()), navigator.pushed)
    }

    @Test
    fun viewersGetNoWayIntoTheForm() {
        // Regression: a viewer was offered New work, and its submit could only 403.
        show(load = { WorkFeed.Sources() }, user = Samples.currentUser(role = CurrentUser.ROLE_VIEWER))
        compose.onNodeWithText("Nothing needs you right now").assertIsDisplayed()
        compose.onNodeWithTag("new-work").assertDoesNotExist()
        compose.onNodeWithTag("empty-state-action").assertDoesNotExist()
        assertEquals(emptyList<NavKey>(), navigator.pushed)
    }

    @Test
    fun aFailedFirstLoadShowsTheErrorNotAnEmptyState() {
        // Regression: an unreachable server read "Nothing needs you right now" under the error.
        show(load = { throw java.io.IOException("Connection refused") })
        compose.onNodeWithTag("error-row").assertIsDisplayed()
        compose.onNodeWithText("Nothing needs you right now").assertDoesNotExist()
        compose.onNodeWithTag("empty-state-action").assertDoesNotExist()
    }

    @Test
    fun membersKeepTheFab() {
        show(user = Samples.currentUser(role = CurrentUser.ROLE_MEMBER))
        compose.onNodeWithTag("new-work").assertIsDisplayed()
    }

    @Test
    fun theViewChipsSwitchViewsWithTheirCounts() {
        val vm = show()
        compose.onNodeWithText("History 7").performClick()
        compose.waitUntil(5_000) { vm.view.value == WorkView.HISTORY }
        compose.onNodeWithText("Upgrade the payments SDK").assertIsDisplayed()
        compose.onNodeWithTag("work-counts").assertIsDisplayed()
        compose.onNodeWithText("1 needs you · 4 running · 3 waiting · 4 recurring · 2 agents").assertIsDisplayed()
    }

    @Test
    fun searchNarrowsTheViewAndClosingClearsIt() {
        val vm = show(initialView = WorkView.ALL)
        compose.onNodeWithTag("work-search-toggle").performClick()
        compose.onNodeWithTag("work-search").assertIsDisplayed()
        compose.runOnIdle { vm.setQuery("mobile-app") }
        compose.waitForIdle()
        compose.onNodeWithText("Migrate the image cache to Coil 3").assertIsDisplayed()
        compose.onNodeWithText("Try the new image loader").assertIsDisplayed()
        compose.onNodeWithTag("work-search-clear").performClick()
        assertEquals("", vm.query.value)
        compose.onNodeWithTag("work-search").assertIsDisplayed()
        // The top bar's action closes it.
        compose.onNodeWithTag("work-search-toggle").performClick()
        compose.onNodeWithTag("work-search").assertDoesNotExist()
    }
}
