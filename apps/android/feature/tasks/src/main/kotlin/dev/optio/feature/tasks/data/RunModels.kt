package dev.optio.feature.tasks.data

import dev.optio.core.ui.format.Cost
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement

// Row shapes returned by the task-related routes (iOS `Features/Run/Tasks/RunModels.swift`).
// Routes enrich rows beyond the generated `OptioTask` (prNumber, prChecksStatus, costUsd,
// isStalled, …) and several fields are nullable in practice, so these are declared locally with
// everything optional; see apps/api/src/schemas/task.ts. Dates never fail a decode
// ([LenientInstantSerializer]).

/** A task row (`tasks`), as the detail, list, subtask, dependency and blueprint-run routes return it. */
@Serializable
data class TaskRow(
    val id: String,
    val title: String = "",
    val prompt: String? = null,
    val repoUrl: String? = null,
    val repoBranch: String? = null,
    val state: String = "",
    val agentType: String? = null,
    val sessionId: String? = null,
    val prUrl: String? = null,
    val prNumber: Int? = null,
    val prState: String? = null,
    val prChecksStatus: String? = null,
    val prReviewStatus: String? = null,
    val resultSummary: String? = null,
    val costUsd: String? = null,
    val inputTokens: Long? = null,
    val outputTokens: Long? = null,
    val modelUsed: String? = null,
    val errorMessage: String? = null,
    val ticketSource: String? = null,
    val ticketExternalId: String? = null,
    val retryCount: Int? = null,
    val maxRetries: Int? = null,
    val priority: Int? = null,
    val parentTaskId: String? = null,
    val taskType: String? = null,
    val blocksParent: Boolean? = null,
    val isStalled: Boolean? = null,
    val pendingReason: String? = null,
    /** `cluster` (an Optio pod) or `local` (a terminal on the owner's machine). */
    val runTarget: String? = null,
    val localDir: String? = null,
    /** Local runs: the `local_terminals` row executing this task. */
    val localTerminalId: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val lastActivityAt: Instant? = null,
    val activitySubstate: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val startedAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val completedAt: Instant? = null,
) {
    /** `owner/repo` (iOS `repoShortName`). */
    val repoShortName: String
        get() = RunFormatting.repoShortName(repoUrl.orEmpty())

    /** "PR #519" once a PR exists. */
    val prLabel: String?
        get() {
            if (prUrl == null) return null
            if (prNumber != null) return "PR #$prNumber"
            val last = prUrl.trimEnd('/').substringAfterLast('/', "")
            return if (last.isNotEmpty()) "PR #$last" else "PR"
        }

    /** "#519" for rows. */
    val prNumberLabel: String?
        get() = prNumber?.let { "#$it" } ?: prUrl?.trimEnd('/')?.substringAfterLast('/', "")?.takeIf { it.isNotEmpty() }?.let { "#$it" }

    val costText: String?
        get() = Cost.formatIfNonZero(costUsd)

    /** Runs on the owner's machine (Optio Local) rather than in a pod. */
    val isLocal: Boolean
        get() = runTarget == "local"

    /** Running with no recent activity (the list routes' `isStalled`). */
    val isStalledRunning: Boolean
        get() = isStalled == true && state == "running"
}

/** `GET /api/tasks/:id`: the task plus its enrichment. */
@Serializable
data class TaskDetailResponse(
    val task: TaskRow,
    val pendingReason: String? = null,
    val stallInfo: StallInfoRow? = null,
)

/** The silent-activity detector's output for a running task. */
@Serializable
data class StallInfoRow(
    val isStalled: Boolean = false,
    val silentForMs: Double = 0.0,
    val thresholdMs: Double? = null,
    val lastLogSummary: String? = null,
)

/** A `task_events` row (`GET /api/tasks/:id/events`); only the trigger drives UI (plan review). */
@Serializable
data class TaskEventRow(
    val id: String = "",
    val fromState: String? = null,
    val toState: String? = null,
    val trigger: String? = null,
    val message: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
)

/** Item of `GET /api/tasks/:id/activity`: comments, state events and messages merged. */
@Serializable
data class TaskActivityItem(
    val type: String = "",
    val id: String,
    val taskId: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    val content: String? = null,
    val user: ActivityUser? = null,
    val fromState: String? = null,
    val toState: String? = null,
    val trigger: String? = null,
    val message: String? = null,
    val userId: String? = null,
    val mode: String? = null,
    @Serializable(with = LenientInstantSerializer::class) val deliveredAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val ackedAt: Instant? = null,
) {
    @Serializable
    data class ActivityUser(
        val id: String? = null,
        val displayName: String? = null,
        val avatarUrl: String? = null,
    )

    val isComment: Boolean
        get() = type == "comment"
}

/** A repo from `GET /api/repos` (the scheduled form's picker). */
@Serializable
data class RunRepoRow(
    val id: String,
    val repoUrl: String,
    val fullName: String? = null,
    val defaultBranch: String? = null,
    val defaultAgentType: String? = null,
) {
    val displayName: String
        get() = fullName ?: RunFormatting.repoShortName(repoUrl)
}

/** A prompt template from `GET /api/prompt-templates?kind=…`. */
@Serializable
data class RunPromptTemplateRow(
    val id: String,
    val name: String,
    val template: String = "",
    val kind: String? = null,
    val description: String? = null,
    val defaultAgentType: String? = null,
)

/** A scheduled Task blueprint (`task_configs` row). */
@Serializable
data class TaskConfigRow(
    val id: String,
    val name: String = "",
    val description: String? = null,
    val title: String = "",
    val prompt: String = "",
    val promptTemplateId: String? = null,
    val repoUrl: String = "",
    val repoBranch: String? = null,
    val agentType: String? = null,
    val maxRetries: Int? = null,
    val priority: Int? = null,
    val enabled: Boolean = true,
    val runTarget: String? = null,
    val localDir: String? = null,
    val agentOptions: Map<String, JsonElement>? = null,
    @Serializable(with = LenientInstantSerializer::class) val createdAt: Instant? = null,
    @Serializable(with = LenientInstantSerializer::class) val updatedAt: Instant? = null,
)

/** Shared formatting of the Run screens (iOS `RunFormatting`). */
object RunFormatting {
    /** `https://github.com/acme/web.git` → `acme/web` (drops the scheme and the host). */
    fun repoShortName(url: String): String {
        var s = url
        val scheme = s.indexOf("://")
        if (scheme >= 0) s = s.substring(scheme + 3)
        val slash = s.indexOf('/')
        if (slash >= 0) s = s.substring(slash + 1)
        if (s.endsWith(".git")) s = s.dropLast(4)
        return s
    }

    /** Agent runtimes, value → label (the web's agent picker order). */
    val agentTypes: List<Pair<String, String>> = listOf(
        "claude-code" to "Claude Code",
        "codex" to "OpenAI Codex",
        "copilot" to "GitHub Copilot",
        "opencode" to "OpenCode",
        "gemini" to "Google Gemini",
        "openclaw" to "OpenClaw",
        "cursor" to "Cursor",
    )

    /** "Claude Code"; null → "default agent" (a blueprint that uses the repo's default). */
    fun agentLabel(type: String?): String {
        if (type == null) return "default agent"
        return agentTypes.firstOrNull { it.first == type }?.second ?: type
    }

    /** "45s", "3m 12s", "1h 4m" from milliseconds. */
    fun duration(ms: Double): String {
        val s = (ms / 1000).toLong().coerceAtLeast(0)
        if (s >= 3600) return "${s / 3600}h ${(s % 3600) / 60}m"
        if (s >= 60) return "${s / 60}m ${s % 60}s"
        return "${s}s"
    }

    /** The web task list's stage (pipeline-timeline.tsx): queue, setup, running, ci, review, … */
    fun stage(task: TaskRow): String = when (task.state) {
        "completed", "cancelled" -> "done"
        "failed" -> "failed"
        "pending", "queued", "waiting_on_deps" -> "queue"
        "provisioning" -> "setup"
        "running" -> "running"
        "needs_attention" -> "attention"
        "pr_opened" -> when {
            task.prReviewStatus != null && task.prReviewStatus !in setOf("none", "pending") -> "review"
            task.prChecksStatus == "passing" -> "review"
            else -> "ci"
        }
        else -> "queue"
    }
}
