package dev.optio.feature.more

import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.FcmAvailability
import dev.optio.core.glance.NotificationPermissionState
import dev.optio.core.glance.PushRegistration
import dev.optio.core.glance.PushState
import dev.optio.core.glance.ServerPushState
import dev.optio.core.model.OptioJson
import dev.optio.core.network.CurrentUser
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.Samples
import dev.optio.feature.more.api.ApiKeyRow
import dev.optio.feature.more.api.ClaudeAuthStatus
import dev.optio.feature.more.api.NotificationPref
import dev.optio.feature.more.api.PushDevices
import dev.optio.feature.more.api.RepoRef
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.api.WebhookDeliveryRow
import dev.optio.feature.more.api.WebhookRow
import dev.optio.feature.more.api.WorkspaceDetail
import dev.optio.feature.more.api.WorkspaceMemberRow
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.secrets.SecretsData
import dev.optio.feature.more.webhooks.WebhookDetail
import dev.optio.feature.more.workspace.WorkspaceData
import java.time.Instant
import kotlinx.serialization.Serializable

/**
 * Sample data for the More screens' UI tests and screenshots: the captured fixtures where they
 * exist (DevLab seed on the auth-enabled test API), dated around [Samples.NOW] where a screenshot
 * needs relative times that read well.
 */
object MoreSamples {
    @Serializable
    private data class Keys(val keys: List<ApiKeyRow>)

    @Serializable
    private data class Prefs(val preferences: Map<String, NotificationPref>)

    @Serializable
    private data class Members(val members: List<WorkspaceMemberRow>)

    @Serializable
    private data class Workspaces(val workspaces: List<WorkspaceRow>)

    @Serializable
    private data class Repos(val repos: List<RepoRef>)

    private fun ago(minutes: Long): String = Samples.agoIso(minutes)

    fun user(role: String?) = when (role) {
        "admin" -> CurrentUser("u-ada", "github", "ada-admin@example.com", "Ada Admin", "ada-admin", null, WS, "admin")
        "viewer" -> CurrentUser("u-vic", "github", "vic-viewer@example.com", "Vic Viewer", "vic-viewer", null, WS, "viewer")
        else -> CurrentUser("u-mia", "github", "mia-member@example.com", "Mia Member", "mia-member", null, WS, "member")
    }

    val authDisabledUser = CurrentUser("local", "local", "dev@localhost", "Local Dev", authDisabled = true)

    val laptop = ServerProfile(id = "dev-server", name = "MacBook Pro", url = "http://laptop.tail0c2d.ts.net:30400", color = ServerColor.SLATE, workspaceId = null)
    val studio = ServerProfile(id = "studio", name = "Studio", url = "https://studio.tail0c2d.ts.net", color = ServerColor.TEAL, workspaceId = "4a94e89e-13c5-44b9-996b-75d08dcb58e0")
    val cluster = ServerProfile(id = "cluster", name = "prod", url = "https://optio.example.com", color = ServerColor.AMBER)

    val repos: List<RepoRef> get() = Fixtures.decode<Repos>("repos.json").repos

    val secrets = SecretsData(
        secrets = listOf(
            SecretRow("s1", "ANTHROPIC_API_KEY", "global", createdAt = ago(60 * 24 * 12), updatedAt = ago(60 * 26)),
            SecretRow("s2", "GITHUB_TOKEN", "global", createdAt = ago(60 * 24 * 12)),
            SecretRow("s3", "SENTRY_AUTH_TOKEN", "https://github.com/e2e-org/e2e-repo", updatedAt = ago(55)),
            SecretRow("s4", "LINEAR_API_KEY", "user", userId = "u-mia", updatedAt = ago(8)),
        ),
        repos = listOf(RepoRef("r1", "https://github.com/e2e-org/e2e-repo", "e2e-org/e2e-repo"), RepoRef("r2", "https://github.com/e2e-org/mobile-app", "e2e-org/mobile-app")),
    )

    val webhooks = listOf(
        WebhookRow(
            id = "8230ea20-4742-4047-b684-8988723d6c6b",
            url = "https://hooks.example.invalid/optio",
            events = listOf("task.completed", "task.failed", "workflow_run.completed"),
            description = "Posts task outcomes to the team's chat bridge",
            active = true,
            createdAt = ago(60 * 5),
        ),
        WebhookRow(
            id = "b1",
            url = "https://hooks.slack.com/services/T000/B000/XXXX",
            events = listOf("task.pr_opened", "task.needs_attention", "review.completed", "workflow_run.failed", "workflow_run.started"),
            description = "#eng-agents",
            secret = "••••••",
            active = false,
            createdAt = ago(60 * 24 * 3),
        ),
    )

    val webhookDetail = WebhookDetail(
        webhook = webhooks[0],
        deliveries = listOf(
            WebhookDeliveryRow(
                id = "d1",
                event = "task.completed",
                payload = OptioJson.parseToJsonElement(
                    """{"event":"task.completed","timestamp":"2026-09-22T16:31:00Z","data":{"taskId":"t-42","taskTitle":"Fix flaky login test","toState":"completed","fromState":"pr_opened"}}""",
                ),
                statusCode = 200,
                responseBody = "ok",
                success = true,
                attempt = 1,
                deliveredAt = ago(9),
            ),
            WebhookDeliveryRow(id = "d2", event = "task.failed", statusCode = null, success = false, attempt = 3, error = "fetch failed", deliveredAt = ago(47)),
            WebhookDeliveryRow(id = "d3", event = "workflow_run.completed", statusCode = 502, responseBody = "Bad gateway", success = false, attempt = 1, deliveredAt = ago(120)),
        ),
    )

    val workspaces: List<WorkspaceRow> get() = Fixtures.decode<Workspaces>("workspaces.json").workspaces

    fun workspace(role: String): WorkspaceData {
        val detail = Fixtures.decode<WorkspaceDetail>(if (role == "admin") "workspace.json" else "workspace-member-view.json")
        val members = Fixtures.decode<Members>("workspace-members.json").members
        return WorkspaceData(detail.workspace, role, members)
    }

    val apiKeys: List<ApiKeyRow>
        get() = Fixtures.decode<Keys>("api-keys.json").keys.let { keys ->
            listOf(
                keys[0].copy(createdAt = ago(60 * 24 * 30), lastUsedAt = ago(2)),
                keys[1].copy(createdAt = ago(60 * 24 * 2), expiresAt = Instant.parse("2026-12-21T16:40:00Z").toString()),
                ApiKeyRow("k3", "CI release bot", "optio_pat_9f", lastUsedAt = ago(60 * 24 * 6), createdAt = ago(60 * 24 * 90)),
            )
        }

    val preferences: Map<String, NotificationPref> get() = Fixtures.decode<Prefs>("notification-preferences.json").preferences

    val claudeAvailable = ClaudeAuthStatus.Subscription(available = true, expiresAt = Samples.NOW.plusSeconds(3600 * 5).toString(), expired = false, lastValidated = ago(4))
    val claudeExpired = ClaudeAuthStatus.Subscription(available = false, error = "OAuth token has expired — please paste a new one", expired = true, lastValidated = ago(12))

    /** The captured device list, re-dated around [Samples.NOW]. */
    val devices: PushDevices
        get() = Fixtures.decode<PushDevices>("notification-devices.json").let { list ->
            list.copy(devices = list.devices.mapIndexed { i, d -> d.copy(lastSeenAt = ago(if (i == 0) 60L * 26 else 3L), createdAt = ago(60L * 24 * 9)) })
        }

    val pushRegistered = PushState(
        permission = NotificationPermissionState.GRANTED,
        fcm = FcmAvailability.Available,
        token = "fake-a8-instance:APA91bFakeTokenForFixturesOnly_0123456789abcdef",
        servers = mapOf(
            "dev-server" to ServerPushState("dev-server", PushRegistration.REGISTERED, serverCanPush = true, deviceId = "57db64ed-20d6-47ed-8613-6b5d32f050ca"),
            "studio" to ServerPushState("studio", PushRegistration.FAILED, error = "Couldn't reach the server to register this device."),
        ),
    )

    val pushNotConfigured = PushState(permission = NotificationPermissionState.NOT_DETERMINED, fcm = FcmAvailability.NotConfigured)

    const val WS = "35802f88-a258-4eca-9817-be325718ab9e"
}
