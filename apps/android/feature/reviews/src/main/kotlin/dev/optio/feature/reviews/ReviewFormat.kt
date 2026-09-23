package dev.optio.feature.reviews

import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Chat
import androidx.compose.material.icons.outlined.ThumbDown
import androidx.compose.material.icons.outlined.ThumbUp
import androidx.compose.ui.graphics.vector.ImageVector
import dev.optio.core.ui.theme.Tone
import java.util.Locale

/** Labels, tones and options of the review screens (iOS `ReviewFormat`). */
internal object ReviewFormat {
    fun stateLabel(state: String): String = when (state) {
        "waiting_ci" -> "Waiting for CI"
        "reviewing" -> "Reviewing…"
        "ready" -> "Draft Ready"
        else -> state.replace('_', ' ').capitalizedWords()
    }

    /** Review state → tone. `ready` (a draft waiting for you) is the only accent. */
    fun stateTone(state: String): Tone = when (state) {
        "queued", "waiting_ci", "stale", "cancelled" -> Tone.IDLE
        "reviewing" -> Tone.WORKING
        "ready" -> Tone.ACCENT
        "failed" -> Tone.DANGER
        "submitted" -> Tone.SUCCESS
        else -> Tone.forState(state)
    }

    fun verdictLabel(verdict: String): String = when (verdict) {
        "approve" -> "Approve"
        "request_changes" -> "Request Changes"
        "comment" -> "Comment"
        else -> verdict
    }

    fun verdictTone(verdict: String): Tone = when (verdict) {
        "approve" -> Tone.SUCCESS
        "request_changes" -> Tone.DANGER
        else -> Tone.WORKING
    }

    fun verdictIcon(verdict: String): ImageVector = when (verdict) {
        "approve" -> Icons.Outlined.ThumbUp
        "request_changes" -> Icons.Outlined.ThumbDown
        else -> Icons.AutoMirrored.Outlined.Chat
    }

    /** The verdicts a draft can carry, in the order the editor shows them. */
    val verdicts: List<String> = listOf("approve", "request_changes", "comment")

    val mergeMethods: List<Pair<String, String>> = listOf(
        "squash" to "Squash and merge",
        "merge" to "Create a merge commit",
        "rebase" to "Rebase and merge",
    )

    /** The list's state filter (client-side): "" = all, `unreviewed` = PRs with no review. */
    val stateOptions: List<Pair<String, String>> = listOf(
        "" to "All",
        "unreviewed" to "Unreviewed",
        "queued" to "Queued",
        "waiting_ci" to "Waiting CI",
        "reviewing" to "Reviewing",
        "ready" to "Ready",
        "stale" to "Stale",
        "submitted" to "Submitted",
        "failed" to "Failed",
    )

    /** The review pipeline under the detail header. */
    val pipeline: List<Pair<String, String>> = listOf(
        "queued" to "Queued",
        "waiting_ci" to "CI",
        "reviewing" to "Reviewing",
        "ready" to "Ready",
        "submitted" to "Submitted",
    )

    /** The step [state] is on (`stale` sits on Ready; failed / cancelled on none). */
    fun pipelineStep(state: String): Int = when (state) {
        "stale" -> 3
        "failed", "cancelled" -> -1
        else -> pipeline.indexOfFirst { it.first == state }
    }

    fun pipelineFailed(state: String): Boolean = state == "failed" || state == "stale"

    /** What the agent is doing while a review is [PrReview.isWorking]. */
    fun workingHint(state: String): String = when (state) {
        "waiting_ci" -> "Waiting for CI to finish — the agent starts reviewing once checks complete."
        "queued" -> "Queued — a worker will pick this up shortly."
        else -> "Agent is reviewing the PR. The draft appears when it's done."
    }

    /** The detail header's accent line, when the review waits on you. */
    fun needsYou(state: String): String? = when (state) {
        "ready" -> "Draft ready — read it and submit"
        "stale" -> "New commits since this review — consider re-reviewing"
        else -> null
    }

    /** Agent runtimes for "Assign to Optio" (iOS `RunFormatting.agentTypes`). */
    val agentTypes: List<Pair<String, String>> = listOf(
        "claude-code" to "Claude Code",
        "codex" to "OpenAI Codex",
        "copilot" to "GitHub Copilot",
        "opencode" to "OpenCode",
        "gemini" to "Google Gemini",
        "openclaw" to "OpenClaw",
        "cursor" to "Cursor",
    )

    /** An Inbox row's trailing text for the Optio task working on it (iOS `IssueRowView`). */
    fun issueTaskLabel(issue: IssueRow): Pair<String, Tone?>? {
        val task = issue.optioTask ?: return if (issue.isAssignable) null else "auto-sync" to null
        return when (val state = task.state) {
            "completed" -> "Done" to Tone.SUCCESS
            "pr_opened" -> "PR open" to null
            "failed" -> "Failed" to Tone.DANGER
            "needs_attention" -> "Needs you" to Tone.ACCENT
            null -> "Assigned" to null
            else -> state.replace('_', ' ').capitalizedWords() to null
        }
    }
}

/** "1 issue", "3 issues". */
internal fun counted(count: Int, noun: String): String = "$count $noun${if (count == 1) "" else "s"}"

/** Swift's `capitalized`: every word's first letter upper, the rest lower. */
internal fun String.capitalizedWords(): String =
    split(' ').joinToString(" ") { word -> word.lowercase(Locale.US).replaceFirstChar { it.titlecase(Locale.US) } }
