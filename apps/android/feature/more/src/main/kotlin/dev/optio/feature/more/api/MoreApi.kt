package dev.optio.feature.more.api

import dev.optio.core.network.ApiClient
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject

// Row types for the More tab's routes (iOS `MoreAPI.swift`, the settings / secrets / webhooks /
// workspace parts). Many of these routes answer `z.unknown()` rows, so every field that the app
// does not key on is optional: a server that adds or drops a column never breaks decoding. Dates
// stay ISO strings (`String.relativeDescription()` in :core:ui formats them).

// region Secrets

/** One secret: name and scope only. Values are write-only and never returned by the API. */
@Serializable
data class SecretRow(
    val id: String? = null,
    val name: String,
    val scope: String? = null,
    val userId: String? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    /** Secrets are unique per (name, scope); some rows may lack an id (iOS `listId`). */
    val listId: String
        get() = id ?: "$name@${scope ?: SCOPE_GLOBAL}"

    companion object {
        const val SCOPE_GLOBAL = "global"
        const val SCOPE_USER = "user"
    }
}

@Serializable
data class SecretCreateResult(
    val name: String,
    val scope: String? = null,
    val validation: Validation? = null,
) {
    @Serializable
    data class Validation(
        val valid: Boolean,
        val error: String? = null,
    )
}

@Serializable
private data class SecretsEnvelope(val secrets: List<SecretRow> = emptyList())

@Serializable
private data class SecretBody(
    val name: String,
    val value: String,
    val scope: String,
)

/** The repos a secret can be scoped to (only what the scope picker needs). */
@Serializable
data class RepoRef(
    val id: String,
    val repoUrl: String? = null,
    val fullName: String? = null,
) {
    val displayName: String
        get() = fullName ?: repoUrl ?: id
}

@Serializable
private data class ReposEnvelope(val repos: List<RepoRef> = emptyList())

// endregion

// region Webhooks

@Serializable
data class WebhookRow(
    val id: String,
    val url: String? = null,
    val events: List<String>? = null,
    val description: String? = null,
    /** Masked ("••••••") when set, null otherwise. */
    val secret: String? = null,
    val active: Boolean? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val isPaused: Boolean
        get() = active == false

    val isSigned: Boolean
        get() = !secret.isNullOrEmpty()
}

@Serializable
data class WebhookDeliveryRow(
    val id: String,
    val webhookId: String? = null,
    val event: String? = null,
    val payload: JsonElement? = null,
    val statusCode: Int? = null,
    val responseBody: String? = null,
    val success: Boolean? = null,
    val attempt: Int? = null,
    val error: String? = null,
    val deliveredAt: String? = null,
)

@Serializable
data class WebhookCreateInput(
    val url: String,
    val events: List<String>,
    val secret: String? = null,
    val description: String? = null,
)

@Serializable
private data class WebhooksEnvelope(val webhooks: List<WebhookRow> = emptyList())

@Serializable
private data class WebhookEnvelope(val webhook: WebhookRow)

@Serializable
private data class DeliveriesEnvelope(val deliveries: List<WebhookDeliveryRow> = emptyList())

@Serializable
private data class DeliveryEnvelope(val delivery: WebhookDeliveryRow)

@Serializable
private data class ActiveBody(val active: Boolean)

@Serializable
private data class TestEventBody(val event: String? = null)

// endregion

// region Workspaces

@Serializable
data class WorkspaceRow(
    val id: String,
    val name: String? = null,
    val slug: String? = null,
    val description: String? = null,
    /** The caller's role in it (the list rows carry it; the detail answers it beside). */
    val role: String? = null,
    val allowDockerInDocker: Boolean? = null,
    val createdAt: String? = null,
) {
    val displayName: String
        get() = name ?: slug ?: id
}

/** `GET /api/workspaces/:id` → `{ workspace, role }`. */
@Serializable
data class WorkspaceDetail(
    val workspace: WorkspaceRow,
    val role: String? = null,
)

@Serializable
data class WorkspaceMemberRow(
    val id: String,
    val workspaceId: String? = null,
    val userId: String,
    val role: String? = null,
    val email: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val createdAt: String? = null,
) {
    val label: String
        get() = displayName?.takeIf { it.isNotBlank() } ?: email ?: userId
}

@Serializable
data class LookupUser(
    val id: String,
    val email: String? = null,
    val displayName: String? = null,
)

@Serializable
private data class WorkspacesEnvelope(val workspaces: List<WorkspaceRow> = emptyList())

@Serializable
private data class WorkspaceEnvelope(val workspace: WorkspaceRow)

@Serializable
private data class MembersEnvelope(val members: List<WorkspaceMemberRow> = emptyList())

@Serializable
private data class LookupEnvelope(val user: LookupUser)

@Serializable
private data class WorkspaceBody(
    val name: String,
    val slug: String,
    val description: String? = null,
)

@Serializable
private data class MemberBody(
    val userId: String,
    val role: String,
)

@Serializable
private data class RoleBody(val role: String)

// endregion

// region Settings

/** `GET /api/optio/settings` → `{ settings }` (the route answers `z.unknown()`). */
@Serializable
data class OptioSettingsRow(
    val model: String? = null,
    val systemPrompt: String? = null,
    val enabledTools: List<String>? = null,
    val confirmWrites: Boolean? = null,
    val maxTurns: Double? = null,
    val defaultReviewAgentType: String? = null,
    val defaultReviewModel: String? = null,
)

@Serializable
private data class SettingsEnvelope(val settings: OptioSettingsRow)

/** `GET /api/auth/status`: the Claude subscription / OAuth token agents use. */
@Serializable
data class ClaudeAuthStatus(val subscription: Subscription = Subscription()) {
    @Serializable
    data class Subscription(
        val available: Boolean? = null,
        val expiresAt: String? = null,
        val error: String? = null,
        val expired: Boolean? = null,
        val lastValidated: String? = null,
    )
}

@Serializable
data class AuthProviderInfo(
    val name: String,
    val displayName: String? = null,
)

/** `GET /api/auth/providers` (public). */
@Serializable
data class AuthProviders(
    val providers: List<AuthProviderInfo> = emptyList(),
    val authDisabled: Boolean = false,
)

@Serializable
data class ApiKeyRow(
    val id: String,
    val name: String? = null,
    /** The token's first 12 characters (`optio_pat_51`). */
    val prefix: String? = null,
    val lastUsedAt: String? = null,
    val expiresAt: String? = null,
    val createdAt: String? = null,
)

/** `POST /api/auth/api-keys` → the only response that ever carries the whole token. */
@Serializable
data class CreatedApiKey(
    val token: String,
    val tokenId: String? = null,
    val prefix: String? = null,
    val name: String? = null,
)

@Serializable
private data class ApiKeysEnvelope(val keys: List<ApiKeyRow> = emptyList())

@Serializable
private data class ApiKeyBody(
    val name: String,
    val expiresAt: String? = null,
)

@Serializable
data class NotificationPref(val push: Boolean)

@Serializable
private data class PreferencesEnvelope(val preferences: Map<String, NotificationPref> = emptyMap())

// endregion

// region Push devices

/**
 * One registered device (`GET /api/notifications/devices`): iOS (APNs) or Android (FCM). The
 * token is masked, so a row is deleted by its [id]. Tolerant of the pre-FCM shape (`deviceToken`,
 * no `id` / `platform`), like iOS `DeviceRow`.
 */
@Serializable
data class PushDeviceRow(
    val id: String? = null,
    val token: String? = null,
    val deviceToken: String? = null,
    val platform: String? = null,
    val environment: String? = null,
    val bundleEnv: String? = null,
    val bundleId: String? = null,
    val appId: String? = null,
    val serverId: String? = null,
    val appVersion: String? = null,
    val deviceName: String? = null,
    val failureCount: Double? = null,
    val lastSeenAt: String? = null,
    val createdAt: String? = null,
) {
    /** The token as listed (masked by current servers). */
    val maskedToken: String
        get() {
            val raw = token ?: deviceToken ?: ""
            return if (raw.length > 12 && '…' !in raw) "${raw.take(6)}…${raw.takeLast(4)}" else raw
        }

    /** What `DELETE /api/notifications/devices/:ref` takes: the row id, else the listed token. */
    val deleteRef: String?
        get() = id ?: token ?: deviceToken

    val isAndroid: Boolean
        get() = platform == "android"

    val listKey: String
        get() = id ?: token ?: deviceToken ?: "${deviceName}-${createdAt}"
}

/** Which native push providers the server holds credentials for (null on pre-FCM servers). */
@Serializable
data class PushProviders(
    val apns: Boolean = false,
    val fcm: Boolean = false,
)

@Serializable
data class PushDevices(
    val devices: List<PushDeviceRow> = emptyList(),
    val push: PushProviders? = null,
)

@Serializable
private data class SentEnvelope(val sent: Int = 0)

// endregion

// region Endpoints

// Secrets
suspend fun ApiClient.listSecrets(scope: String? = null): List<SecretRow> =
    get<SecretsEnvelope>("/api/secrets", mapOf("scope" to scope)).secrets

suspend fun ApiClient.upsertSecret(
    name: String,
    value: String,
    scope: String,
): SecretCreateResult = post<SecretCreateResult>("/api/secrets", SecretBody(name, value, scope))

/** `DELETE /api/secrets/:name?scope=` (the name is one path segment; OkHttp percent-encodes it). */
suspend fun ApiClient.deleteSecret(
    name: String,
    scope: String?,
) = delete("/api/secrets/$name", mapOf("scope" to scope))

suspend fun ApiClient.listRepoRefs(): List<RepoRef> = get<ReposEnvelope>("/api/repos").repos

// Webhooks
suspend fun ApiClient.listWebhooks(): List<WebhookRow> = get<WebhooksEnvelope>("/api/webhooks").webhooks

suspend fun ApiClient.getWebhook(id: String): WebhookRow = get<WebhookEnvelope>("/api/webhooks/$id").webhook

suspend fun ApiClient.createWebhook(input: WebhookCreateInput): WebhookRow = post<WebhookEnvelope>("/api/webhooks", input).webhook

suspend fun ApiClient.setWebhookActive(
    id: String,
    active: Boolean,
): WebhookRow = patch<WebhookEnvelope>("/api/webhooks/$id", ActiveBody(active)).webhook

suspend fun ApiClient.deleteWebhook(id: String) = delete("/api/webhooks/$id")

suspend fun ApiClient.testWebhook(
    id: String,
    event: String?,
): WebhookDeliveryRow = post<DeliveryEnvelope>("/api/webhooks/$id/test", TestEventBody(event)).delivery

suspend fun ApiClient.listWebhookDeliveries(
    id: String,
    limit: Int = 50,
): List<WebhookDeliveryRow> = get<DeliveriesEnvelope>("/api/webhooks/$id/deliveries", mapOf("limit" to limit)).deliveries

// Workspaces
suspend fun ApiClient.listWorkspaces(): List<WorkspaceRow> = get<WorkspacesEnvelope>("/api/workspaces").workspaces

suspend fun ApiClient.getWorkspace(id: String): WorkspaceDetail = get<WorkspaceDetail>("/api/workspaces/$id")

suspend fun ApiClient.createWorkspace(
    name: String,
    slug: String,
    description: String?,
): WorkspaceRow = post<WorkspaceEnvelope>("/api/workspaces", WorkspaceBody(name, slug, description)).workspace

suspend fun ApiClient.updateWorkspace(
    id: String,
    name: String,
    slug: String,
    description: String?,
): WorkspaceRow =
    patch<WorkspaceEnvelope>(
        "/api/workspaces/$id",
        // An emptied description clears it (explicit null), like the web form.
        buildJsonObject {
            put("name", JsonPrimitive(name))
            put("slug", JsonPrimitive(slug))
            put("description", description?.let(::JsonPrimitive) ?: JsonNull)
        },
    ).workspace

suspend fun ApiClient.deleteWorkspace(id: String) = delete("/api/workspaces/$id")

suspend fun ApiClient.switchWorkspace(id: String) = post("/api/workspaces/$id/switch")

suspend fun ApiClient.listWorkspaceMembers(id: String): List<WorkspaceMemberRow> =
    get<MembersEnvelope>("/api/workspaces/$id/members").members

suspend fun ApiClient.addWorkspaceMember(
    id: String,
    userId: String,
    role: String,
) = post("/api/workspaces/$id/members", MemberBody(userId, role))

suspend fun ApiClient.updateWorkspaceMemberRole(
    id: String,
    userId: String,
    role: String,
) = patch<Unit>("/api/workspaces/$id/members/$userId", RoleBody(role))

suspend fun ApiClient.removeWorkspaceMember(
    id: String,
    userId: String,
) = delete("/api/workspaces/$id/members/$userId")

suspend fun ApiClient.lookupUser(email: String): LookupUser = get<LookupEnvelope>("/api/users/lookup", mapOf("email" to email)).user

// Settings
suspend fun ApiClient.getOptioSettings(): OptioSettingsRow = get<SettingsEnvelope>("/api/optio/settings").settings

/** `PUT /api/optio/settings` with a body built by the caller (explicit nulls clear the review defaults). */
suspend fun ApiClient.updateOptioSettings(body: JsonElement): OptioSettingsRow = put<SettingsEnvelope>("/api/optio/settings", body).settings

suspend fun ApiClient.claudeAuthStatus(): ClaudeAuthStatus = get<ClaudeAuthStatus>("/api/auth/status")

suspend fun ApiClient.refreshClaudeAuth() = post("/api/auth/refresh")

suspend fun ApiClient.listAuthProviders(): AuthProviders = get<AuthProviders>("/api/auth/providers")

suspend fun ApiClient.listApiKeys(): List<ApiKeyRow> = get<ApiKeysEnvelope>("/api/auth/api-keys").keys

suspend fun ApiClient.createApiKey(
    name: String,
    expiresAt: Instant?,
): CreatedApiKey = post<CreatedApiKey>("/api/auth/api-keys", ApiKeyBody(name, expiresAt?.toString()))

suspend fun ApiClient.revokeApiKey(id: String) = delete("/api/auth/api-keys/$id")

suspend fun ApiClient.getNotificationPreferences(): Map<String, NotificationPref> =
    get<PreferencesEnvelope>("/api/notifications/preferences").preferences

suspend fun ApiClient.updateNotificationPreferences(prefs: Map<String, NotificationPref>): Map<String, NotificationPref> =
    put<PreferencesEnvelope>("/api/notifications/preferences", prefs.mapValues { mapOf("push" to it.value.push) }).preferences

// Push devices
suspend fun ApiClient.listPushDevices(): PushDevices = get<PushDevices>("/api/notifications/devices")

/** Deletes by row id (tokens are masked in the list); raw tokens are accepted too. */
suspend fun ApiClient.deletePushDevice(ref: String) = delete("/api/notifications/devices/$ref")

/** Sends one test alert to every device of the caller; returns how many sends were accepted. */
suspend fun ApiClient.sendTestPush(): Int = post<SentEnvelope>("/api/notifications/devices/test").sent

// endregion
