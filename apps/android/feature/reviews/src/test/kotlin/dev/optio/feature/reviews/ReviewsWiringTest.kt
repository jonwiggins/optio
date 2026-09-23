package dev.optio.feature.reviews

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onAllNodesWithText
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.onNodeWithText
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performTouchInput
import androidx.navigation3.runtime.NavKey
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import dev.optio.core.model.intValue
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.navigation.routes.PullRequestRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.ui.theme.OptioTheme
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlinx.serialization.json.jsonObject
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config

/**
 * The real sections and the review screen against the fake API: their ViewModels are created,
 * load, render, and navigate through `LocalNavigator` (what the hub and the app provide).
 */
@RunWith(AndroidJUnit4::class)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class ReviewsWiringTest {
    @get:Rule
    val compose = createComposeRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val pushed = CopyOnWriteArrayList<NavKey>()
    private val opened = CopyOnWriteArrayList<String>()

    private val navigator = object : Navigator {
        override fun push(route: NavKey) {
            pushed += route
        }

        override fun pop() = Unit

        override fun open(section: Section, view: WorkView?) = Unit

        override fun openExternal(url: String) {
            opened += url
        }
    }

    private fun show(content: @Composable () -> Unit) {
        val api = server.client()
        compose.setContent {
            CompositionLocalProvider(LocalApiClient provides api, LocalNavigator provides navigator) {
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
    fun theReviewsSectionLoadsAndOpensReviewsOrPullRequests() {
        server.fixture("/api/pull-requests", "pull-requests.json")
        server.fixture("/api/repos", "repos.json")
        show { ReviewsSection(PaddingValues()) }
        waitForText("Paginate the activity feed")
        compose.onNodeWithText("Paginate the activity feed").performClick()
        assertEquals(ReviewDetailRoute("7c9e6679-7425-40de-944b-e07fc1f90ae7"), pushed.last())
        compose.onNodeWithText("Add a dark mode toggle to Settings").performClick()
        val pr = assertIs<PullRequestRoute>(pushed.last())
        assertEquals(142, pr.number)
        // Long press → Open on GitHub.
        compose.onNodeWithTag("pr-row-133").performTouchInput { longClick() }
        compose.onNodeWithText("Open on GitHub").performClick()
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/133", opened.last())
    }

    @Test
    fun anEmptyServerShowsTheEmptyState() {
        server.fixture("/api/pull-requests", "pull-requests-empty.json")
        server.fixture("/api/repos", "repos.json")
        show { ReviewsSection(PaddingValues()) }
        waitForText("No open pull requests")
        compose.onNodeWithText("Pull requests from your repos appear here.").fetchSemanticsNode()
    }

    @Test
    fun theInboxAssignsFromARowAndOpensIssues() {
        server.fixture("/api/issues", "issues.json")
        server.fixture("/api/repos", "repos.json")
        server.post("/api/issues/assign") { FakeResponse.fixture("issue-assign.json", 201) }
        show { InboxSection(PaddingValues()) }
        waitForText("Crash when the settings screen opens offline")
        compose.onNodeWithTag("issue-row-#5").performTouchInput { longClick() }
        compose.onNodeWithText("Assign to Optio").performClick()
        await("the assignment") { server.count("POST", "/api/issues/assign") == 1 }
        val request = server.lastRequest("POST", "/api/issues/assign")!!
        assertEquals(5, request.json.jsonObject["issueNumber"]?.intValue)
        waitForText("Queued")
        compose.onNodeWithText("Export costs as CSV").performClick()
        val route = assertIs<IssueDetailRoute>(pushed.last())
        assertEquals("ENG-123", route.numberText)
        assertEquals("linear", route.source)
    }

    @Test
    fun theReviewScreenLoadsItsDraftAndRuns() {
        val id = "7c9e6679-7425-40de-944b-e07fc1f90ae7"
        server.fixture("/api/pr-reviews/$id", "pr-review-ready.json")
        server.fixture("/api/pr-reviews/$id/runs", "pr-review-runs.json")
        server.fixture("/api/pr-reviews/$id/chat", "pr-review-chat.json")
        server.fixture("/api/pr-reviews/$id/logs", "pr-review-logs.json")
        server.fixture("/api/pull-requests/status", "pr-status.json")
        server.webSocket("/ws/pr-reviews/$id/logs")
        show { ReviewDetailScreen(id) }
        waitForText("Draft ready — read it and submit")
        compose.onNodeWithTag("verdict-approve").performClick()
        waitForText("Save Draft")
        compose.onNodeWithTag("tab-Runs").performClick()
        waitForText("Initial")
        compose.onNodeWithTag("tab-Activity").performClick()
        waitForText("Reviewing e2e-org/e2e-repo#138 at c41d0a9")
        compose.onNodeWithTag("open-pr").performClick()
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/138", opened.last())
    }
}
