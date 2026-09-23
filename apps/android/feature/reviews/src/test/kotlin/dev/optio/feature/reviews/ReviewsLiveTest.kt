package dev.optio.feature.reviews

import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Assume.assumeTrue

/**
 * The Reviews and Inbox endpoints against a live private test API. Its repos are fake, so the PR
 * and issue lists (fetched live from GitHub) are empty and PR operations fail with GitHub's 401,
 * which the screens show as their empty and error states. Read-only. Runs only with
 * `OPTIO_TEST_API_URL`.
 */
class ReviewsLiveTest {
    private fun api(): ApiClient {
        val url = System.getenv("OPTIO_TEST_API_URL")
        assumeTrue("OPTIO_TEST_API_URL not set", !url.isNullOrBlank())
        return ApiClient(url, System.getenv("OPTIO_TEST_API_TOKEN") ?: "dev")
    }

    @Test
    fun listsAreEmptyOnFakeRepos() = runTest {
        val api = api()
        val repos = api.listRepoSummaries()
        assertTrue(repos.any { it.displayName == "e2e-org/e2e-repo" })
        assertTrue(api.listOpenPullRequests().isEmpty())
        assertTrue(api.listOpenPullRequests(repos.first().id).isEmpty())
        assertTrue(api.listIssues().isEmpty())
        assertTrue(api.listIssues(state = "all").isEmpty())
    }

    @Test
    fun errorsCarryTheServersReason() = runTest {
        val api = api()
        val missing = assertFailsWith<ApiError> { api.getPrReview("00000000-0000-0000-0000-000000000000") }
        assertEquals(404, missing.status)
        assertEquals("PR review not found", missing.message)
        val status = assertFailsWith<ApiError> { api.prStatus("https://github.com/e2e-org/e2e-repo/pull/1") }
        assertEquals(400, status.status)
        assertTrue(status.message.startsWith("GitHub API error"))
    }
}
