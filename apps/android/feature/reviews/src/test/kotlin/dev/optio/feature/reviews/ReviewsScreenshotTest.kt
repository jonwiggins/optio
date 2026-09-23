package dev.optio.feature.reviews

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.ui.test.longClick
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performTouchInput
import androidx.compose.ui.unit.dp
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.network.ApiError
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.state.LoadState
import kotlin.test.Test

/**
 * Work › Reviews and Inbox and their screens with realistic data, empty and error states, in light
 * and dark (`./gradlew :feature:reviews:recordRoborazziDebug` →
 * `feature/reviews/build/outputs/roborazzi/`).
 */
class ReviewsScreenshotTest : ScreenshotTest() {
    private val prs = Fixtures.decode<PullRequestsEnvelope>("pull-requests.json").pullRequests
    private val repos = Fixtures.decode<ReposEnvelope>("repos.json").repos
    private val issues = Fixtures.decode<IssuesEnvelope>("issues.json").issues
    private val review = Fixtures.decode<ReviewEnvelope>("pr-review-ready.json").review
    private val runs = Fixtures.decode<ReviewRunsEnvelope>("pr-review-runs.json").runs
    private val status = Fixtures.decode<PrStatus>("pr-status.json")
    private val padding = PaddingValues(bottom = 16.dp)

    private fun list(
        state: LoadState<ReviewsListViewModel.Data>,
        ui: ReviewsListViewModel.Ui = ReviewsListViewModel.Ui(),
    ) = Triple(state, ui, state.value?.let { filterPullRequests(it.prs, ui.stateFilter) }.orEmpty())

    @Test
    fun reviewsList() {
        val (state, ui, filtered) = list(LoadState.Loaded(ReviewsListViewModel.Data(prs, repos)), ReviewsListViewModel.Ui(reviewingUrl = prs[0].url))
        captureScreens("ReviewsList", size = ScreenSize.TALL) {
            ReviewsContent(state = state, ui = ui, filtered = filtered, canMutate = true, contentPadding = padding)
        }
    }

    @Test
    fun reviewsRowMenu() {
        val (state, ui, filtered) = list(LoadState.Loaded(ReviewsListViewModel.Data(prs, repos)))
        captureScreens("ReviewsRowMenu", wholeScreen = true, interact = { onNodeWithTag("pr-row-138").performTouchInput { longClick() } }) {
            ReviewsContent(state = state, ui = ui, filtered = filtered, canMutate = true, contentPadding = padding)
        }
    }

    @Test
    fun reviewsEmptyAndFiltered() {
        val (empty, ui, filtered) = list(LoadState.Loaded(ReviewsListViewModel.Data(emptyList(), repos)))
        captureScreens("ReviewsEmpty") { ReviewsContent(state = empty, ui = ui, filtered = filtered, canMutate = true, contentPadding = padding) }
        val (noRepos, _, none) = list(LoadState.Loaded(ReviewsListViewModel.Data(emptyList(), emptyList())))
        captureScreens("ReviewsNoRepos") { ReviewsContent(state = noRepos, ui = ui, filtered = none, canMutate = false, contentPadding = padding) }
        val stale = ReviewsListViewModel.Ui(stateFilter = "stale")
        val (data, _, nothing) = list(LoadState.Loaded(ReviewsListViewModel.Data(prs, repos)), stale)
        captureScreens("ReviewsFilteredEmpty") { ReviewsContent(state = data, ui = stale, filtered = nothing, canMutate = true, contentPadding = padding) }
    }

    @Test
    fun reviewsErrorAndLoading() {
        captureScreens("ReviewsError") {
            ReviewsContent(
                state = LoadState.Failed(ApiError(500, "GitHub API error 401: Bad credentials")),
                ui = ReviewsListViewModel.Ui(prUrl = "https://github.com/e2e-org/e2e-repo/pull/9"),
                filtered = emptyList(),
                canMutate = true,
                contentPadding = padding,
            )
        }
        captureScreens("ReviewsLoading") {
            ReviewsContent(state = LoadState.Loading(), ui = ReviewsListViewModel.Ui(), filtered = emptyList(), canMutate = true, contentPadding = padding)
        }
    }

    @Test
    fun pullRequestSummary() {
        captureScreens("PullRequest") {
            PullRequestContent(route = prs[0].toRoute(), launching = false, error = null, canMutate = true)
        }
        captureScreens("PullRequestFailed") {
            PullRequestContent(
                route = prs[3].toRoute(),
                launching = false,
                error = ApiError(400, "Repository e2e-org/e2e-repo is not configured in Optio. Add it first."),
                canMutate = true,
            )
        }
    }

    private fun detailUi(
        review: PrReview = this.review,
        tab: ReviewDetailViewModel.Tab = ReviewDetailViewModel.Tab.DRAFT,
        logs: List<AgentLogEntry> = emptyList(),
        messages: List<ReviewDetailViewModel.UserMessage> = emptyList(),
        dirty: Boolean = false,
    ) = ReviewDetailUi(
        review = LoadState.Loaded(review),
        runs = runs,
        prStatus = status,
        draft = ReviewDetailViewModel.Draft(
            summary = review.summary.orEmpty(),
            verdict = review.verdict.orEmpty(),
            comments = review.comments.mapIndexed { i, c ->
                ReviewDetailViewModel.DraftComment(i.toLong(), c.path, c.line?.toLong()?.toString().orEmpty(), c.side, c.body)
            },
            dirty = dirty,
        ),
        tab = tab,
        logs = logs,
        userMessages = messages,
        live = true,
    )

    @Test
    fun reviewDraft() {
        captureScreens("ReviewDraft", size = ScreenSize.TALL) {
            ReviewDetailContent(ui = detailUi(dirty = true), actions = ReviewDetailActions())
        }
    }

    @Test
    fun reviewActivity() {
        val messages = listOf(
            ReviewDetailViewModel.UserMessage("chat-1", "Is the limit cap really needed?", Samples.agoIso(4), ReviewDetailViewModel.UserMessage.Status.SENT),
            ReviewDetailViewModel.UserMessage("local-1", "And the offset reset?", Samples.agoIso(1), ReviewDetailViewModel.UserMessage.Status.SENDING),
        )
        captureScreens("ReviewActivity") {
            ReviewDetailContent(
                ui = detailUi(tab = ReviewDetailViewModel.Tab.ACTIVITY, logs = Samples.transcript(), messages = messages),
                actions = ReviewDetailActions(),
            )
        }
    }

    @Test
    fun reviewRuns() {
        captureScreens("ReviewRuns") {
            ReviewDetailContent(ui = detailUi(tab = ReviewDetailViewModel.Tab.RUNS), actions = ReviewDetailActions())
        }
    }

    @Test
    fun reviewInFlightAndFailed() {
        val reviewing = review.copy(state = "waiting_ci", verdict = null, summary = null, fileComments = null)
        captureScreens("ReviewWaitingCi") {
            ReviewDetailContent(ui = detailUi(review = reviewing, tab = ReviewDetailViewModel.Tab.ACTIVITY).copy(prStatus = null, runs = emptyList()), actions = ReviewDetailActions())
        }
        val failed = review.copy(state = "failed", verdict = null, errorMessage = "Agent exited with code 1")
        captureScreens("ReviewFailed") {
            ReviewDetailContent(ui = detailUi(review = failed, tab = ReviewDetailViewModel.Tab.DRAFT), actions = ReviewDetailActions())
        }
        val submitted = review.copy(state = "submitted", verdict = "approve", autoSubmitted = true)
        captureScreens("ReviewSubmitted") {
            ReviewDetailContent(
                ui = detailUi(review = submitted).copy(prStatus = status.copy(prState = "merged", checksStatus = "passing")),
                actions = ReviewDetailActions(),
            )
        }
        captureScreens("ReviewLoadFailed") {
            ReviewDetailContent(ui = ReviewDetailUi(review = LoadState.Failed(ApiError(404, "PR review not found"))), actions = ReviewDetailActions())
        }
    }

    @Test
    fun inbox() {
        captureScreens("Inbox", size = ScreenSize.TALL) {
            InboxContent(issues = LoadState.Loaded(issues), repos = repos, filter = InboxViewModel.Filter(), canMutate = true, contentPadding = padding)
        }
    }

    @Test
    fun inboxEmptyAndError() {
        captureScreens("InboxEmpty") {
            InboxContent(issues = LoadState.Loaded(emptyList()), repos = repos, filter = InboxViewModel.Filter(state = "closed"), canMutate = true, contentPadding = padding)
        }
        captureScreens("InboxNoRepos") {
            InboxContent(issues = LoadState.Loaded(emptyList()), repos = emptyList(), filter = InboxViewModel.Filter(), canMutate = true, contentPadding = padding)
        }
        captureScreens("InboxError") {
            InboxContent(
                issues = LoadState.Failed(ApiError(0, "Could not connect to the server.", cause = java.net.ConnectException())),
                repos = emptyList(),
                filter = InboxViewModel.Filter(),
                canMutate = true,
                contentPadding = padding,
            )
        }
    }

    @Test
    fun issueDetail() {
        captureScreens("IssueDetail") {
            IssueDetailContent(route = issues[0].toRoute(), state = IssueDetailViewModel.State(agentType = "codex"), assignable = true, canMutate = true)
        }
        captureScreens("IssueDetailTicket") {
            IssueDetailContent(route = issues[2].toRoute(), state = IssueDetailViewModel.State(), assignable = false, canMutate = true)
        }
        captureScreens("IssueDetailAssigned") {
            IssueDetailContent(
                route = IssueDetailRoute(identity = "x", title = issues[0].title, numberText = "#7", number = 7, repoName = "e2e-org/e2e-repo", state = "open"),
                state = IssueDetailViewModel.State(createdTaskId = "t1"),
                assignable = true,
                canMutate = true,
            )
        }
    }
}
