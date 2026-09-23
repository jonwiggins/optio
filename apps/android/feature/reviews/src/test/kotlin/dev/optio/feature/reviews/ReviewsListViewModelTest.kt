package dev.optio.feature.reviews

import androidx.lifecycle.viewModelScope
import dev.optio.core.model.stringValue
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/** Work › Reviews against the fake API (iOS `ReviewsListModel`). */
class ReviewsListViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    private fun routes() {
        server.fixture("/api/pull-requests", "pull-requests.json")
        server.fixture("/api/repos", "repos.json")
    }

    @Test
    fun loadsPrsAndReposAndFiltersClientSide() = runTest(main.dispatcher) {
        routes()
        val vm = ReviewsListViewModel(server.client())
        vm.refresh()
        val data = vm.state.first { it is LoadState.Loaded }.value!!
        assertEquals(6, data.prs.size)
        assertEquals(2, data.repos.size)
        assertNull(server.lastRequest("GET", "/api/pull-requests")!!.queryParam("repoId"))

        assertEquals(6, vm.filtered(data, "").size)
        assertEquals(listOf(142, 141), vm.filtered(data, "unreviewed").map { it.number })
        assertEquals(listOf(138), vm.filtered(data, "ready").map { it.number })
        assertEquals(listOf(56), vm.filtered(data, "failed").map { it.number })
        vm.setStateFilter("submitted")
        assertEquals(listOf(133), vm.filtered(data).map { it.number })
        vm.viewModelScope.cancel()
    }

    @Test
    fun theRepoFilterRefetches() = runTest(main.dispatcher) {
        routes()
        val vm = ReviewsListViewModel(server.client())
        vm.refresh()
        vm.state.first { it is LoadState.Loaded }
        server.clearRequests()
        vm.setRepoFilter("142e78f2-2b76-4205-a498-51a404d04776")
        val request = server.nextRequest("GET", "/api/pull-requests")
        assertEquals("142e78f2-2b76-4205-a498-51a404d04776", request.queryParam("repoId"))
        vm.state.first { it is LoadState.Loaded }
        vm.setRepoFilter("142e78f2-2b76-4205-a498-51a404d04776")
        vm.state.first { it is LoadState.Loaded }
        assertEquals(1, server.count("GET", "/api/pull-requests"), "the same filter doesn't refetch")
        vm.viewModelScope.cancel()
    }

    @Test
    fun aFailedLoadKeepsNothingAndReposAreOptional() = runTest(main.dispatcher) {
        server.error("GET", "/api/pull-requests", 500, "GitHub API error 401")
        server.error("GET", "/api/repos", 500, "nope")
        val vm = ReviewsListViewModel(server.client())
        vm.reload()
        val failed = assertIs<LoadState.Failed<*>>(vm.state.value)
        assertEquals(500, (failed.error as ApiError).status)

        routes()
        server.error("GET", "/api/repos", 500, "still nope")
        vm.reload()
        val data = vm.state.value.value!!
        assertEquals(6, data.prs.size)
        assertTrue(data.repos.isEmpty(), "a failed repo list doesn't fail the PRs (iOS try?)")
        vm.viewModelScope.cancel()
    }

    @Test
    fun launchingFromTheUrlFieldOpensTheReviewAndClearsTheField() = runTest(main.dispatcher) {
        routes()
        server.post("/api/pr-reviews") { FakeResponse.fixture("pr-review-ready.json", 201) }
        val vm = ReviewsListViewModel(server.client())
        vm.setPrUrl("  https://github.com/e2e-org/e2e-repo/pull/138 ")
        vm.launchFromUrlField()
        assertEquals(ScreenEvent.Toast("Review started"), vm.events.first())
        assertEquals(ScreenEvent.Open(ReviewDetailRoute("7c9e6679-7425-40de-944b-e07fc1f90ae7")), vm.events.first())
        assertEquals("", vm.ui.value.prUrl)
        assertEquals(false, vm.ui.value.launchingUrl)
        val body = server.lastRequest("POST", "/api/pr-reviews")!!.json.jsonObject
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/138", body["prUrl"]?.stringValue)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aRejectedLaunchReportsTheServersReason() = runTest(main.dispatcher) {
        server.error("POST", "/api/pr-reviews", 400, "Repository acme/x is not configured in Optio. Add it first.")
        val vm = ReviewsListViewModel(server.client())
        vm.launchReview("https://github.com/acme/x/pull/1")
        val event = assertIs<ScreenEvent.Failure>(vm.events.first())
        assertEquals("Repository acme/x is not configured in Optio. Add it first.", event.error.message)
        assertNull(vm.ui.value.reviewingUrl)
        vm.viewModelScope.cancel()
    }

    @Test
    fun approveAndMergeApprovesSubmitsThenSquashMerges() = runTest(main.dispatcher) {
        routes()
        server.patch("/api/pr-reviews/:id") { FakeResponse.fixture("pr-review-ready.json") }
        server.post("/api/pr-reviews/:id/submit") { FakeResponse.fixture("pr-review-ready.json") }
        server.json("/api/pull-requests/merge", """{"merged":true}""", method = "POST")
        val vm = ReviewsListViewModel(server.client())
        vm.refresh()
        val pr = vm.state.first { it is LoadState.Loaded }.value!!.prs.first { it.number == 138 }
        server.clearRequests()

        vm.approveAndMerge(pr)
        assertEquals(ScreenEvent.Toast("PR #138 merged"), vm.events.first())
        val calls = server.requests.map { "${it.method} ${it.path}" }.filter { !it.startsWith("GET") }
        assertEquals(
            listOf(
                "PATCH /api/pr-reviews/7c9e6679-7425-40de-944b-e07fc1f90ae7",
                "POST /api/pr-reviews/7c9e6679-7425-40de-944b-e07fc1f90ae7/submit",
                "POST /api/pull-requests/merge",
            ),
            calls,
        )
        val patch = server.lastRequest("PATCH")!!.json.jsonObject
        assertEquals("approve", patch["verdict"]?.stringValue)
        assertEquals("Approved by user", patch["summary"]?.stringValue)
        assertTrue("fileComments" !in patch, "an unset field is omitted, so the server keeps it")
        val merge = server.lastRequest("POST", "/api/pull-requests/merge")!!.json.jsonObject
        assertEquals("squash", merge["mergeMethod"]?.stringValue)
        assertEquals(pr.url, merge["prUrl"]?.stringValue)
        server.nextRequest("GET", "/api/pull-requests") // reloaded after the merge
        vm.state.first { it is LoadState.Loaded }
        assertNull(vm.ui.value.mergingUrl)
        vm.viewModelScope.cancel()
    }

    @Test
    fun mergingAnUnreviewedPrSkipsTheDraft() = runTest(main.dispatcher) {
        routes()
        server.error("POST", "/api/pull-requests/merge", 400, "Pull Request is not mergeable")
        val vm = ReviewsListViewModel(server.client())
        vm.refresh()
        val pr = vm.state.first { it is LoadState.Loaded }.value!!.prs.first { it.review == null }
        vm.approveAndMerge(pr)
        val event = assertIs<ScreenEvent.Failure>(vm.events.first())
        assertEquals("Pull Request is not mergeable", event.error.message)
        assertEquals(0, server.count("PATCH"))
        assertEquals(0, server.count("POST", "/api/pr-reviews/:id/submit"))
        vm.viewModelScope.cancel()
    }
}
