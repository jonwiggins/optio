package dev.optio.feature.reviews

import dev.optio.core.model.PrReviewFileComment
import dev.optio.core.model.doubleValue
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive

// Route-level shapes of the review and issue routes (iOS `ReviewsAPI.swift`, `RunModels.swift`
// `IssueRow`). `/api/pull-requests` returns git-platform PR summaries enriched with the matching
// `pr_reviews` row; `/api/pr-reviews/:id` the full review. Fields the routes may omit or null are
// optional throughout, like iOS.

/** One open PR from `GET /api/pull-requests`, with its Optio review when one exists. */
@Serializable
data class PullRequestSummary(
    val number: Int,
    val title: String = "",
    val url: String,
    val state: String? = null,
    val draft: Boolean? = null,
    val author: String? = null,
    val labels: List<String>? = null,
    val headSha: String? = null,
    val repo: Repo? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
    val review: EmbeddedReview? = null,
) {
    @Serializable
    data class Repo(
        val id: String? = null,
        val fullName: String? = null,
        val repoUrl: String? = null,
    )

    /** The `pr_reviews` row attached to the PR (id / state / verdict / origin). */
    @Serializable
    data class EmbeddedReview(
        val id: String,
        val state: String? = null,
        val verdict: String? = null,
        val origin: String? = null,
        @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
    ) {
        val canReReview: Boolean
            get() = state in PrReview.RE_REVIEWABLE
    }

    /** `owner/repo#12`: unique across repos (iOS `id`). */
    val key: String
        get() = "${repo?.fullName.orEmpty()}#$number"

    /** "GitHub" / "GitLab" / "CodeCommit" for "Open on …". */
    val platformName: String
        get() = platformName(url)
}

/** A `pr_reviews` row (`GET /api/pr-reviews/:id` → `{ review }`). */
@Serializable
data class PrReview(
    val id: String,
    val prUrl: String,
    val prNumber: Int? = null,
    val repoOwner: String? = null,
    val repoName: String? = null,
    val repoUrl: String? = null,
    val headSha: String? = null,
    val state: String,
    val verdict: String? = null,
    val summary: String? = null,
    /** Raw objects: the agent writes them, so decode each one leniently ([comments]). */
    val fileComments: List<JsonElement>? = null,
    val origin: String? = null,
    val userEngaged: Boolean? = null,
    val autoSubmitted: Boolean? = null,
    @Serializable(with = LenientInstantSerializer::class) val submittedAt: Instant? = null,
    val errorMessage: String? = null,
    val controlIntent: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
) {
    val repoFullName: String
        get() = listOfNotNull(repoOwner, repoName).joinToString("/")

    /** The draft can be edited and submitted (the server accepts PATCH only here). */
    val isEditable: Boolean
        get() = state in EDITABLE

    /** The agent is still producing the draft. */
    val isWorking: Boolean
        get() = state in WORKING

    val hasDraft: Boolean
        get() = state in HAS_DRAFT

    val canReReview: Boolean
        get() = state in RE_REVIEWABLE

    val canCancel: Boolean
        get() = state != "cancelled" && state != "submitted"

    val platformName: String
        get() = platformName(prUrl)

    /** The inline comments, tolerating agent output that misses a field. */
    val comments: List<PrReviewFileComment>
        get() = fileComments.orEmpty().mapNotNull { element ->
            val obj = element as? kotlinx.serialization.json.JsonObject ?: return@mapNotNull null
            PrReviewFileComment(
                path = obj["path"]?.stringValue.orEmpty(),
                line = obj["line"]?.doubleValue ?: obj["line"]?.stringValue?.toDoubleOrNull(),
                side = obj["side"]?.stringValue,
                body = obj["body"]?.stringValue.orEmpty(),
            )
        }

    companion object {
        val EDITABLE = setOf("ready", "stale")
        val WORKING = setOf("queued", "waiting_ci", "reviewing")
        val HAS_DRAFT = setOf("ready", "stale", "submitted")
        val RE_REVIEWABLE = setOf("ready", "stale", "submitted", "failed")
    }
}

/** One agent execution against a review (`GET /api/pr-reviews/:id/runs` → `{ runs }`, newest first). */
@Serializable
data class PrReviewRun(
    val id: String,
    val kind: String? = null,
    val state: String,
    val resultSummary: String? = null,
    val errorMessage: String? = null,
    val costUsd: String? = null,
    val inputTokens: Int? = null,
    val outputTokens: Int? = null,
    val modelUsed: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val startedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val completedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
)

/** One message of a review's chat thread (`GET /api/pr-reviews/:id/chat` → `{ messages }`). */
@Serializable
data class ReviewChatMessage(
    val id: String,
    val runId: String? = null,
    val role: String,
    val content: String = "",
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
)

/** CI + review status of a PR on its host (`GET /api/pull-requests/status`). */
@Serializable
data class PrStatus(
    val checksStatus: String? = null,
    val reviewStatus: String? = null,
    val mergeable: Boolean? = null,
    val prState: String? = null,
    val headSha: String? = null,
) {
    val isOpen: Boolean
        get() = prState == "open"

    val checksOk: Boolean
        get() = checksStatus == "passing" || checksStatus == "none"
}

/** A repo row from `GET /api/repos` (only what the Reviews and Inbox filters need). */
@Serializable
data class RepoSummary(
    val id: String,
    val fullName: String? = null,
    val repoUrl: String? = null,
    val defaultAgentType: String? = null,
) {
    val displayName: String
        get() = fullName ?: repoUrl?.let(::repoPath) ?: id
}

/** An issue or ticket from `GET /api/issues`. Its shape varies by provider (`schemas/session.ts`). */
@Serializable
data class IssueRow(
    /** GitHub's numeric id, or `source:externalId` for external trackers. */
    val id: JsonElement? = null,
    /** An issue number, or a tracker key like `ENG-123`. */
    val number: JsonElement? = null,
    val title: String = "",
    val body: String? = null,
    val state: String? = null,
    val url: String? = null,
    val labels: List<String>? = null,
    val author: String? = null,
    val assignee: String? = null,
    val source: String? = null,
    val hasOptioLabel: Boolean? = null,
    val repo: Repo? = null,
    val optioTask: OptioTaskRef? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    @Serializable
    data class Repo(
        val id: String? = null,
        val fullName: String? = null,
        val repoUrl: String? = null,
    )

    /** The Optio task already working on the issue. */
    @Serializable
    data class OptioTaskRef(
        val taskId: String? = null,
        val state: String? = null,
    )

    /** "#12", or the tracker key as is ("ENG-123"). */
    val numberText: String
        get() {
            val primitive = number as? JsonPrimitive ?: return ""
            if (primitive.isString) return primitive.content
            primitive.content.toDoubleOrNull()?.let { return "#${it.toLong()}" }
            return ""
        }

    /** The numeric issue number (what `POST /api/issues/assign` takes); null for tracker keys. */
    val numberInt: Int?
        get() = (number as? JsonPrimitive)?.takeUnless { it.isString }?.content?.toDoubleOrNull()?.toInt()

    /** GitHub / GitLab issues in a configured repo with no task yet can be assigned from here. */
    val isAssignable: Boolean
        get() = (source == null || source == "github" || source == "gitlab") && repo?.id != null && optioTask == null

    /** Stable key across repos and trackers (iOS `identity`). */
    val identity: String
        get() {
            val idText = (id as? JsonPrimitive)?.let { if (it.isString) it.content else it.content.toDoubleOrNull()?.toString() }.orEmpty()
            return "${repo?.fullName ?: source.orEmpty()}-$numberText-$idText"
        }

    /** The host this issue lives on, for "Open on …". */
    val hostName: String
        get() = when (source) {
            null, "github" -> "GitHub"
            "gitlab" -> "GitLab"
            else -> source.replaceFirstChar { it.uppercase() }
        }
}

/** The task `POST /api/issues/assign` created (only what the Inbox needs). */
@Serializable
data class AssignedTask(
    val id: String,
    val title: String? = null,
    val state: String? = null,
)

internal fun platformName(url: String): String = when {
    "gitlab" in url -> "GitLab"
    "codecommit" in url -> "CodeCommit"
    else -> "GitHub"
}

/** `https://github.com/acme/web.git` → `acme/web` (iOS `RunFormatting.repoShortName`). */
internal fun repoPath(url: String): String {
    var s = url
    val scheme = s.indexOf("://")
    if (scheme >= 0) s = s.substring(scheme + 3)
    val slash = s.indexOf('/')
    if (slash >= 0) s = s.substring(slash + 1)
    return s.removeSuffix(".git")
}

// region Envelopes

@Serializable
internal data class PullRequestsEnvelope(val pullRequests: List<PullRequestSummary> = emptyList())

@Serializable
internal data class ReviewEnvelope(val review: PrReview)

@Serializable
internal data class ReviewRunsEnvelope(val runs: List<PrReviewRun> = emptyList())

@Serializable
internal data class ReviewLogsEnvelope(
    val logs: List<dev.optio.core.ui.log.TaskLogRow> = emptyList(),
    val runId: String? = null,
)

@Serializable
internal data class ReviewChatEnvelope(val messages: List<ReviewChatMessage> = emptyList())

@Serializable
internal data class ReposEnvelope(val repos: List<RepoSummary> = emptyList())

@Serializable
internal data class IssuesEnvelope(val issues: List<IssueRow> = emptyList())

@Serializable
internal data class AssignedTaskEnvelope(val task: AssignedTask)

// endregion
