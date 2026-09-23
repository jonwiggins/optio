package dev.optio.feature.insights

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onAllNodesWithContentDescription
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollTo
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiError
import dev.optio.core.network.CurrentUser
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.FakeResponse
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/** The real Insights sections and the pod screen against the fake API (ViewModels, loading, navigation). */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class InsightsWiringTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val pushed = CopyOnWriteArrayList<NavKey>()
    private var popped = 0

    private val navigator = object : Navigator {
        override fun push(route: NavKey) {
            pushed += route
        }

        override fun pop() {
            popped++
        }

        override fun open(section: Section, view: WorkView?) = Unit

        override fun openExternal(url: String) = Unit
    }

    private fun show(user: CurrentUser? = null, content: @Composable () -> Unit) {
        val api = server.client()
        compose.setContent {
            CompositionLocalProvider(LocalApiClient provides api, LocalNavigator provides navigator, LocalCurrentUser provides user) {
                OptioTheme(darkTheme = false) { content() }
            }
        }
    }

    /**
     * Polls [condition], idling the main looper in between: network replies resume on it, and
     * `waitUntil` alone doesn't pump it for conditions that aren't UI state.
     */
    private fun await(what: String, timeoutMs: Long = 10_000, condition: () -> Boolean) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            compose.waitForIdle()
            if (condition()) return
            check(System.currentTimeMillis() < deadline) { "Timed out waiting for $what" }
            Thread.sleep(20)
        }
    }

    private fun waitForText(text: String) =
        await("\"$text\"") { compose.onAllNodesWithText(text).fetchSemanticsNodes().isNotEmpty() }

    @Test
    fun analyticsLoadsAndSwitchesPeriod() {
        server.fixture("/api/analytics/performance", "analytics-performance.json")
        server.fixture("/api/analytics/agents", "analytics-agents.json")
        server.fixture("/api/analytics/failures", "analytics-failures.json")
        server.fixture("/api/analytics/prs", "analytics-prs.json")
        show { AnalyticsSection(PaddingValues()) }
        // Stat tiles speak as "label: value" (their text is cleared into a description).
        await("the success tile") { compose.onAllNodesWithContentDescription("Success: 44%").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Tasks over time").fetchSemanticsNode()
        compose.onNodeWithTag("tab-7d").performClick()
        await("a 7-day reload") { server.requests("GET", "/api/analytics/prs").any { it.queryParam("days") == "7" } }
    }

    @Test
    fun costsLoadAndOpenATask() {
        server.fixture("/api/analytics/costs", "analytics-costs.json")
        server.json("/api/repos", """{"repos":[]}""")
        show { CostsSection(PaddingValues()) }
        waitForText("Paginate the activity feed")
        compose.onNodeWithText("Paginate the activity feed").performScrollTo().performClick()
        assertEquals(TaskDetailRoute("6241d1e4-cb9e-4876-bc33-3c7b8e787251"), pushed.last())
    }

    /**
     * QA: after a repo filter's load failed (`repoUrl` 500s on the current API), the all-repos
     * numbers stayed up under the active filter. Now only the error shows; a failed refresh of
     * the same filter still keeps its numbers, flagged.
     */
    @Test
    fun aFailedFilterChangeShowsOnlyTheError() {
        val costs: CostAnalytics = Fixtures.decode("analytics-costs.json")
        val failed = LoadState.Failed(ApiError(500, "Internal Server Error"), previous = costs)
        var shown by mutableStateOf(CostsViewModel.Filter())
        show {
            CostsContent(state = failed, filter = CostsViewModel.Filter(repoUrl = "https://github.com/e2e-org/mobile-app"), shownFilter = shown, contentPadding = PaddingValues())
        }
        waitForText("Couldn't load costs — the server hit an error.")
        assertEquals(0, compose.onAllNodesWithContentDescription("Total: $2.15").fetchSemanticsNodes().size, "no all-repos numbers under the repo filter")
        compose.onNodeWithTag("retry").fetchSemanticsNode()

        shown = CostsViewModel.Filter(repoUrl = "https://github.com/e2e-org/mobile-app")
        await("the same filter's numbers, flagged") { compose.onAllNodesWithContentDescription("Total: $2.15").fetchSemanticsNodes().isNotEmpty() }
        compose.onNodeWithText("Couldn't load costs — the server hit an error.").fetchSemanticsNode()
    }

    @Test
    fun activityShowsTheServersErrorWithRetry() {
        server.on("GET", "/api/activity") { FakeResponse.fixture("activity-error.json", 500) }
        show { ActivitySection(PaddingValues()) }
        waitForText("Couldn't load activity — the server hit an error.")
        server.fixture("/api/activity", "activity.json")
        compose.onNodeWithTag("retry").performClick()
        waitForText("Ada Admin task.retry succeeded")
    }

    @Test
    fun clusterListsPodsAndOpensARepoPod() {
        server.fixture("/api/cluster/overview", "cluster-overview.json")
        server.fixture("/api/cluster/pods", "cluster-pods.json")
        server.fixture("/api/cluster/health-events", "cluster-health-events.json")
        server.fixture("/api/cluster/version", "cluster-version.json")
        show { ClusterSection(PaddingValues()) }
        waitForText("optio-repo-mobile-app-0")
        compose.onNodeWithTag("chip-Repo pods").performClick()
        waitForText("e2e-org/e2e-repo #0")
        compose.onNodeWithText("e2e-org/e2e-repo #0").performClick()
        assertEquals(PodDetailRoute("765b3ac4-c6d1-44b5-ae35-bb5a831da9f4"), pushed.last())
    }

    @Test
    fun theClusterIsForAdmins() {
        server.error("GET", "/api/cluster/overview", 403, "Insufficient permissions")
        server.fixture("/api/cluster/version", "cluster-version.json")
        show { ClusterSection(PaddingValues()) }
        waitForText("Admins only")
        waitForText("Optio dev")
    }

    @Test
    fun aPodRestartsAfterConfirmation() {
        val id = "765b3ac4-c6d1-44b5-ae35-bb5a831da9f4"
        server.fixture("/api/cluster/pods/$id", "cluster-pod.json")
        server.fixture("/api/cluster/health-events", "cluster-health-events.json")
        server.json("/api/cluster/pods/$id/restart", """{"ok":true}""", method = "POST")
        show(user = CurrentUser(id = "ada", role = CurrentUser.ROLE_ADMIN)) { PodDetailScreen(id) }
        waitForText("Fix the Safari date picker")
        compose.onNodeWithTag("restart-pod").performClick()
        compose.onNodeWithText("Restart pod").performClick()
        await("the pop after the restart") { popped == 1 }
        assertEquals(1, server.count("POST", "/api/cluster/pods/$id/restart"))
    }
}
