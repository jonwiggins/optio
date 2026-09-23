package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:reviews` (Agent A4). iOS: Features/Run/{Reviews,Issues}/*.

/** A PR review (`pr_reviews` row): its draft, the agent's activity and its runs. */
@Serializable
data class ReviewDetailRoute(val id: String) : NavKey

/**
 * An open pull request that has no Optio review yet (iOS `PullRequestSummaryView`): its facts and
 * "Review with Optio". The API has no single-PR route, so the key carries what the list row knew;
 * [labels] is already joined for display and [updatedAt] is the ISO string from the list.
 */
@Serializable
data class PullRequestRoute(
    val url: String,
    val number: Int,
    val title: String,
    val repo: String? = null,
    val author: String? = null,
    val updatedAt: String? = null,
    val draft: Boolean = false,
    val labels: String? = null,
) : NavKey

/**
 * An Inbox issue (iOS `IssueDetailView`): read it, open it on its host, or assign it to Optio. The
 * API has no single-issue route, so the key carries the row's fields ([body] is capped by the
 * caller to keep saved state small). [identity] is the row's key in the Inbox list, [assigned] is
 * true once Optio has a task for it ([taskId] when known).
 */
@Serializable
data class IssueDetailRoute(
    val identity: String,
    val title: String,
    val numberText: String = "",
    val number: Int? = null,
    val repoId: String? = null,
    val repoName: String? = null,
    val source: String? = null,
    val state: String? = null,
    val url: String? = null,
    val author: String? = null,
    val assignee: String? = null,
    val body: String? = null,
    val taskId: String? = null,
    val assigned: Boolean = false,
) : NavKey
