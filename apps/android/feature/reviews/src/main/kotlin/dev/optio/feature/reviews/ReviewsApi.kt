package dev.optio.feature.reviews

import dev.optio.core.model.PrReviewFileComment
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.log.TaskLogRow
import kotlinx.serialization.Serializable

// Endpoints of Work › Reviews and Work › Inbox (iOS `ReviewsAPI.swift`, `IssuesAPI.swift`).

/** Open PRs across the workspace's repos, optionally one repo's (`GET /api/pull-requests`). */
suspend fun ApiClient.listOpenPullRequests(repoId: String? = null): List<PullRequestSummary> =
    get<PullRequestsEnvelope>("/api/pull-requests", mapOf("repoId" to repoId)).pullRequests

/** The workspace's repos, for the repo filters (`GET /api/repos`). */
suspend fun ApiClient.listRepoSummaries(): List<RepoSummary> = get<ReposEnvelope>("/api/repos").repos

/** Launches a review of [prUrl] (`POST /api/pr-reviews`); an existing review re-runs instead. */
suspend fun ApiClient.createPrReview(prUrl: String): PrReview =
    post<ReviewEnvelope>("/api/pr-reviews", PrUrlBody(prUrl)).review

suspend fun ApiClient.getPrReview(id: String): PrReview = get<ReviewEnvelope>("/api/pr-reviews/$id").review

suspend fun ApiClient.listPrReviewRuns(id: String): List<PrReviewRun> =
    get<ReviewRunsEnvelope>("/api/pr-reviews/$id/runs").runs

/**
 * Saves the draft (`PATCH /api/pr-reviews/:id`). A null [verdict] or [fileComments] leaves that
 * field as it is (iOS sends only what is set).
 */
suspend fun ApiClient.updatePrReview(
    id: String,
    summary: String?,
    verdict: String?,
    fileComments: List<PrReviewFileComment>?,
): PrReview = patch<ReviewEnvelope>("/api/pr-reviews/$id", DraftPatchBody(summary, verdict, fileComments)).review

/** Posts the review to the git host (`POST /api/pr-reviews/:id/submit` → `{ review, reviewUrl }`). */
suspend fun ApiClient.submitPrReview(id: String): PrReview = post<ReviewEnvelope>("/api/pr-reviews/$id/submit").review

suspend fun ApiClient.reReviewPr(id: String) = post("/api/pr-reviews/$id/re-review")

suspend fun ApiClient.cancelPrReview(id: String) = post("/api/pr-reviews/$id/cancel")

/** Stored agent logs of the latest run, or of [runId] (`GET /api/pr-reviews/:id/logs`). */
suspend fun ApiClient.prReviewLogs(id: String, runId: String? = null): List<TaskLogRow> =
    get<ReviewLogsEnvelope>("/api/pr-reviews/$id/logs", mapOf("runId" to runId)).logs

suspend fun ApiClient.listPrReviewChat(id: String): List<ReviewChatMessage> =
    get<ReviewChatEnvelope>("/api/pr-reviews/$id/chat").messages

/** Asks the reviewer a follow-up (`POST /api/pr-reviews/:id/chat`); the reply arrives as a chat run. */
suspend fun ApiClient.postPrReviewChat(id: String, message: String) = post("/api/pr-reviews/$id/chat", ChatBody(message))

suspend fun ApiClient.prStatus(prUrl: String): PrStatus = get("/api/pull-requests/status", mapOf("prUrl" to prUrl))

/** Merges [prUrl] on its host with `squash` / `merge` / `rebase` (`POST /api/pull-requests/merge`). */
suspend fun ApiClient.mergePullRequest(prUrl: String, method: String) =
    post("/api/pull-requests/merge", MergeBody(prUrl, method))

/** Issues across repos and trackers (`GET /api/issues`); a null [state] means open. */
suspend fun ApiClient.listIssues(repoId: String? = null, state: String? = null): List<IssueRow> =
    get<IssuesEnvelope>("/api/issues", mapOf("repoId" to repoId, "state" to state)).issues

/**
 * Creates a Repo Task for an issue and labels it `optio` (`POST /api/issues/assign`), what the
 * web's "Assign to Optio" does. A null [agentType] uses the repo's default agent.
 */
suspend fun ApiClient.assignIssue(
    number: Int,
    repoId: String,
    title: String,
    body: String,
    agentType: String? = null,
): AssignedTask = post<AssignedTaskEnvelope>("/api/issues/assign", AssignIssueBody(number, repoId, title, body, agentType)).task

@Serializable
private data class PrUrlBody(val prUrl: String)

@Serializable
private data class ChatBody(val message: String)

@Serializable
private data class MergeBody(val prUrl: String, val mergeMethod: String)

/** Nulls are omitted on the wire (`OptioJson.explicitNulls = false`): the server keeps those fields. */
@Serializable
private data class DraftPatchBody(
    val summary: String? = null,
    val verdict: String? = null,
    val fileComments: List<PrReviewFileComment>? = null,
)

@Serializable
private data class AssignIssueBody(
    val issueNumber: Int,
    val repoId: String,
    val title: String,
    val body: String,
    val agentType: String? = null,
)
