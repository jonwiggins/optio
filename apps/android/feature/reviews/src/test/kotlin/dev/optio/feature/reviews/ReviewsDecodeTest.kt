package dev.optio.feature.reviews

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.OptioJson
import dev.optio.core.navigation.AppRouter
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.navigation.routes.PullRequestRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.testing.Fixtures
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The review and issue routes' JSON (captured from the private test API, or built from the route code). */
class ReviewsDecodeTest {
    @Test
    fun pullRequestsDecodeWithTheirReviews() {
        val prs = Fixtures.decode<PullRequestsEnvelope>("pull-requests.json").pullRequests
        assertEquals(listOf(142, 138, 57, 141, 133, 56), prs.map { it.number })

        val unreviewed = prs[0]
        assertNull(unreviewed.review)
        assertEquals("e2e-org/e2e-repo#142", unreviewed.key)
        assertEquals(Instant.parse("2026-09-22T16:20:00Z"), unreviewed.updatedAt)
        assertEquals(listOf("ui", "settings"), unreviewed.labels)
        assertEquals("GitHub", unreviewed.platformName)

        val ready = prs[1].review!!
        assertEquals("ready", ready.state)
        assertEquals("request_changes", ready.verdict)
        assertTrue(ready.canReReview)
        assertEquals(Instant.parse("2026-09-22T16:31:12Z"), ready.updatedAt)

        assertFalse(prs[2].review!!.canReReview, "a review in flight can't be re-run")
        assertEquals(true, prs[3].draft)
        assertTrue(prs[5].review!!.canReReview, "failed reviews can be re-run")
        assertEquals("0b5e3f7a8c22", prs[2].headSha)
    }

    @Test
    fun capturedEmptyListsAndReposDecode() {
        assertTrue(Fixtures.decode<PullRequestsEnvelope>("pull-requests-empty.json").pullRequests.isEmpty())
        assertTrue(Fixtures.decode<IssuesEnvelope>("issues-empty.json").issues.isEmpty())
        val repos = Fixtures.decode<ReposEnvelope>("repos.json").repos
        assertEquals(listOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), repos.map { it.displayName })
        assertEquals("claude-code", repos.first().defaultAgentType)
    }

    @Test
    fun aReviewDecodesWithItsDraft() {
        val review = Fixtures.decode<ReviewEnvelope>("pr-review-ready.json").review
        assertEquals("e2e-org/e2e-repo", review.repoFullName)
        assertEquals(138, review.prNumber)
        assertTrue(review.isEditable)
        assertTrue(review.hasDraft)
        assertTrue(review.canCancel)
        assertFalse(review.isWorking)
        assertEquals("GitHub", review.platformName)
        assertNull(review.submittedAt)
        val comments = review.comments
        assertEquals(2, comments.size)
        assertEquals("apps/web/src/app/activity/page.tsx", comments[0].path)
        assertEquals(128.0, comments[0].line)
        assertEquals("RIGHT", comments[0].side)
        assertNull(comments[1].side)
    }

    @Test
    fun agentWrittenCommentsThatMissFieldsDontFailTheReview() {
        val review = OptioJson.decodeFromString<ReviewEnvelope>(
            """{"review":{"id":"r","prUrl":"https://gitlab.com/a/b/-/merge_requests/3","state":"stale",
               "fileComments":[{"path":"a.ts","line":"12"},5,{"body":"only a body"}],"submittedAt":"not a date"}}""",
        ).review
        assertEquals(2, review.comments.size)
        assertEquals(12.0, review.comments[0].line)
        assertEquals("", review.comments[0].body)
        assertEquals("", review.comments[1].path)
        assertNull(review.submittedAt, "an unreadable date is null, not a failure")
        assertEquals("GitLab", review.platformName)
        assertTrue(review.isEditable)
    }

    @Test
    fun runsLogsChatAndStatusDecode() {
        val runs = Fixtures.decode<ReviewRunsEnvelope>("pr-review-runs.json").runs
        assertEquals(listOf("chat", "initial"), runs.map { it.kind })
        assertEquals("0.4213", runs[1].costUsd)
        assertEquals(48211, runs[1].inputTokens)
        assertEquals(Instant.parse("2026-09-22T16:31:05Z"), runs[1].completedAt)

        val logs = Fixtures.decode<ReviewLogsEnvelope>("pr-review-logs.json")
        assertEquals("run-initial-1", logs.runId)
        val entries = logs.logs.map { it.toLogEntry() }
        assertEquals(
            listOf(AgentLogEntry.TypeValue.SYSTEM, AgentLogEntry.TypeValue.TOOL_USE, AgentLogEntry.TypeValue.TEXT, AgentLogEntry.TypeValue.UNKNOWN),
            entries.map { it.type },
            "an unknown log type stays unknown (iOS RunLogRow)",
        )
        assertEquals("Read", (entries[1].metadata?.get("toolName") as kotlinx.serialization.json.JsonPrimitive).content)
        assertEquals("2026-09-22T16:31:04.900Z", entries[3].timestamp, "Postgres text normalises to ISO")

        val chat = Fixtures.decode<ReviewChatEnvelope>("pr-review-chat.json").messages
        assertEquals(listOf("user", "assistant"), chat.map { it.role })

        val status = Fixtures.decode<PrStatus>("pr-status.json")
        assertTrue(status.isOpen)
        assertFalse(status.checksOk)
        assertTrue(PrStatus(checksStatus = "none").checksOk)
    }

    @Test
    fun issuesDecodeAcrossProviders() {
        val issues = Fixtures.decode<IssuesEnvelope>("issues.json").issues
        assertEquals(5, issues.size)

        val github = issues[0]
        assertEquals("#7", github.numberText)
        assertEquals(7, github.numberInt)
        assertTrue(github.isAssignable)
        assertEquals("GitHub", github.hostName)

        val linear = issues[2]
        assertEquals("ENG-123", linear.numberText)
        assertNull(linear.numberInt)
        assertFalse(linear.isAssignable, "tracker tickets are synced, not assigned")
        assertEquals("Linear", linear.hostName)
        assertNull(linear.author)

        val taken = issues[3]
        assertEquals("needs_attention", taken.optioTask?.state)
        assertFalse(taken.isAssignable)

        assertEquals(issues.size, issues.map { it.identity }.toSet().size, "identities are unique")

        val assigned = Fixtures.decode<AssignedTaskEnvelope>("issue-assign.json").task
        assertEquals("Crash when the settings screen opens offline", assigned.title)
        assertEquals("pending", assigned.state)
    }

    @Test
    fun datesAreReadLeniently() {
        assertEquals(Instant.parse("2026-09-22T16:31:12Z"), ReviewDates.parse("2026-09-22T16:31:12.000Z"))
        assertEquals(Instant.parse("2026-09-22T16:31:12Z"), ReviewDates.parse("2026-09-22T18:31:12+02:00"))
        assertEquals(Instant.parse("2026-09-23T00:47:43.464027Z"), ReviewDates.parse("2026-09-23 00:47:43.464027+00"))
        assertEquals(Instant.parse("2026-09-23T00:47:43Z"), ReviewDates.parse("2026-09-23T00:47:43"))
        assertEquals(Instant.ofEpochMilli(1_790_000_000_000), ReviewDates.parse("1790000000000"))
        assertNull(ReviewDates.parse("yesterday"))
        assertNull(ReviewDates.parse(""))
        assertEquals("2026-09-22T16:31:12.000Z", ReviewDates.normalize("2026-09-22T16:31:12Z"))
        assertEquals("garbage", ReviewDates.normalize("garbage"))
    }

    @Test
    fun routeKeysCarryTheRowsAndSurviveSavedState() {
        val pr = Fixtures.decode<PullRequestsEnvelope>("pull-requests.json").pullRequests[0]
        val prRoute = pr.toRoute()
        assertEquals("ui · settings", prRoute.labels)
        assertEquals("2026-09-22T16:20:00.000Z", prRoute.updatedAt)
        assertEquals("e2e-org/e2e-repo", prRoute.repo)

        val issue = Fixtures.decode<IssuesEnvelope>("issues.json").issues[0]
        val issueRoute = issue.toRoute()
        assertEquals(7, issueRoute.number)
        assertEquals("e3ae92d2-e09c-4e1e-b51f-7803685a1e72", issueRoute.repoId)
        assertFalse(issueRoute.assigned)
        val long = issue.copy(body = "x".repeat(20_000)).toRoute()
        assertEquals(16_001, long.body!!.length, "long bodies are capped (with an ellipsis) to keep saved state small")

        val stack = listOf(ReviewDetailRoute("r1"), prRoute, issueRoute, PullRequestRoute(url = "u", number = 1, title = "t"))
        assertEquals(stack, AppRouter.decodeBackStack(AppRouter.encodeBackStack(stack)))
        assertTrue(IssueDetailRoute(identity = "i", title = "t") in AppRouter.decodeBackStack(AppRouter.encodeBackStack(listOf(IssueDetailRoute(identity = "i", title = "t")))))
    }

    @Test
    fun repoPathsAndPlatforms() {
        assertEquals("acme/web", repoPath("https://github.com/acme/web.git"))
        assertEquals("group/sub/app", repoPath("https://gitlab.example.com/group/sub/app"))
        assertEquals("CodeCommit", platformName("https://git-codecommit.us-east-1.amazonaws.com/v1/repos/x"))
    }
}
