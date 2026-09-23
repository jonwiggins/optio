package dev.optio.core.ui.usage

import dev.optio.core.model.LocalHost
import dev.optio.core.network.ApiClient
import kotlinx.serialization.Serializable

// Claude usage and auth status (`GET /api/auth/usage`, `GET /api/auth/status`), iOS
// `Features/Usage/UsageAPI.swift`. Route-local shapes: the TS schema leaves them untyped.

@Serializable
data class UsageWindow(
    val utilization: Double? = null,
    val resetsAt: String? = null,
)

/** A per-model 7-day cap (Fable, …): a model can be locked while the account-wide 7-day looks fine. */
@Serializable
data class UsageModelWindow(
    val model: String,
    val utilization: Double? = null,
    val resetsAt: String? = null,
    val severity: String? = null,
)

@Serializable
data class ExtraUsage(
    val isEnabled: Boolean? = null,
    val monthlyLimit: Double? = null,
    val usedCredits: Double? = null,
    val utilization: Double? = null,
)

@Serializable
data class AuthFailures(
    val claude: Boolean? = null,
    val github: Boolean? = null,
)

/** The `usage` envelope of `/api/auth/usage` (web `api-client.ts` `getUsage`). */
@Serializable
data class ClaudeUsageData(
    val available: Boolean = false,
    val error: String? = null,
    val hasRecentAuthFailure: Boolean? = null,
    val authFailures: AuthFailures? = null,
    val fiveHour: UsageWindow? = null,
    val sevenDay: UsageWindow? = null,
    val sevenDaySonnet: UsageWindow? = null,
    val sevenDayOpus: UsageWindow? = null,
    val sevenDayModels: List<UsageModelWindow>? = null,
    val extraUsage: ExtraUsage? = null,
    /** When Anthropic answered. With [stale], the age of the last good numbers. */
    val asOf: String? = null,
    /** Last good numbers, served because the latest upstream read failed. */
    val stale: Boolean? = null,
) {
    /** Mirrors the web `UsagePanel`'s Claude-failure detection. */
    val claudeAuthFailed: Boolean
        get() {
            authFailures?.claude?.let { return it }
            if (hasRecentAuthFailure == true) return true
            if (!available && error != null) return "401" in error || "expired" in error.lowercase()
            return false
        }

    val githubAuthFailed: Boolean
        get() = authFailures?.github ?: false
}

@Serializable
data class AuthSubscriptionStatus(
    val available: Boolean? = null,
    val expiresAt: String? = null,
    val error: String? = null,
    val expired: Boolean? = null,
    val lastValidated: String? = null,
)

@Serializable
data class DashAuthStatus(
    val subscription: AuthSubscriptionStatus? = null,
)

@Serializable
internal data class UsageEnvelope(val usage: ClaudeUsageData)

@Serializable
internal data class LocalHostsEnvelope(val hosts: List<LocalHost> = emptyList())

/** `GET /api/auth/usage`; [fresh] bypasses the server's 5-minute cache and re-reads from Anthropic. */
suspend fun ApiClient.accountUsage(fresh: Boolean = false): ClaudeUsageData =
    get<UsageEnvelope>("/api/auth/usage", query = mapOf("fresh" to if (fresh) "1" else null)).usage

/** `GET /api/auth/status`: whether the Claude subscription token is present and still valid. */
suspend fun ApiClient.dashAuthStatus(): DashAuthStatus = get("/api/auth/status")

/** `GET /api/local/hosts`, for the Codex snapshots the daemons report. */
internal suspend fun ApiClient.usageLocalHosts(): List<LocalHost> = get<LocalHostsEnvelope>("/api/local/hosts").hosts
