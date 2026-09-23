package dev.optio.feature.more

import dev.optio.core.model.OptioJson
import dev.optio.core.model.PushDevicesResponse
import dev.optio.core.model.PushPlatform
import dev.optio.core.network.CurrentUser
import dev.optio.core.testing.Fixtures
import dev.optio.feature.more.api.ApiKeyRow
import dev.optio.feature.more.api.AuthProviders
import dev.optio.feature.more.api.ClaudeAuthStatus
import dev.optio.feature.more.api.CreatedApiKey
import dev.optio.feature.more.api.LookupUser
import dev.optio.feature.more.api.NotificationPref
import dev.optio.feature.more.api.OptioSettingsRow
import dev.optio.feature.more.api.PushDevices
import dev.optio.feature.more.api.RepoRef
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.api.WebhookDeliveryRow
import dev.optio.feature.more.api.WebhookRow
import dev.optio.feature.more.api.WorkspaceDetail
import dev.optio.feature.more.api.WorkspaceMemberRow
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.secrets.normalizeSecrets
import dev.optio.feature.more.settings.AgentSettingsForm
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/**
 * Every fixture captured from the private auth-enabled test API (Ada Admin, Mia Member, Vic
 * Viewer; DevLab seed) decodes into the row types the More screens use.
 */
class FixtureDecodeTest {
    @Serializable
    private data class Secrets(val secrets: List<SecretRow>)

    @Serializable
    private data class Repos(val repos: List<RepoRef>)

    @Serializable
    private data class Webhooks(val webhooks: List<WebhookRow>)

    @Serializable
    private data class OneWebhook(val webhook: WebhookRow)

    @Serializable
    private data class Deliveries(val deliveries: List<WebhookDeliveryRow>)

    @Serializable
    private data class OneDelivery(val delivery: WebhookDeliveryRow)

    @Serializable
    private data class Workspaces(val workspaces: List<WorkspaceRow>)

    @Serializable
    private data class Members(val members: List<WorkspaceMemberRow>)

    @Serializable
    private data class Lookup(val user: LookupUser)

    @Serializable
    private data class Settings(val settings: OptioSettingsRow)

    @Serializable
    private data class Keys(val keys: List<ApiKeyRow>)

    @Serializable
    private data class Preferences(val preferences: Map<String, NotificationPref>)

    @Serializable
    private data class Me(val user: CurrentUser, val authDisabled: Boolean = false)

    @Test
    fun secretsDecodeAndTheDuplicateUserRowCollapses() {
        assertTrue(Fixtures.decode<Secrets>("secrets.json").secrets.isEmpty())
        val raw = Fixtures.decode<Secrets>("secrets-duplicates.json").secrets
        assertEquals(3, raw.size, "the server lists the caller's user secret twice")
        val shown = normalizeSecrets(raw, "all")
        assertEquals(listOf("A8_PROBE_USER", "A8_PROBE_REPO"), shown.map { it.name })
        assertEquals("user", shown[0].scope)
        assertEquals("https://github.com/e2e-org/e2e-repo", shown[1].scope)
        // `?scope=global` answers the user rows too; the client keeps only global ones.
        val global = Fixtures.decode<Secrets>("secrets-scope-global.json").secrets
        assertEquals(1, global.size)
        assertTrue(normalizeSecrets(global, "global").isEmpty())
    }

    @Test
    fun reposForTheScopePicker() {
        val repos = Fixtures.decode<Repos>("repos.json").repos
        assertEquals(listOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), repos.map { it.displayName })
        assertEquals("https://github.com/e2e-org/e2e-repo", repos[0].repoUrl)
    }

    @Test
    fun webhooksAndDeliveries() {
        val list = Fixtures.decode<Webhooks>("webhooks.json").webhooks
        val hook = list.single()
        assertEquals("Posts task outcomes to the team's chat bridge", hook.description)
        assertEquals(listOf("task.completed", "task.failed", "workflow_run.completed"), hook.events)
        assertFalse(hook.isPaused)
        assertFalse(hook.isSigned)
        assertEquals(hook, Fixtures.decode<OneWebhook>("webhook.json").webhook)

        val deliveries = Fixtures.decode<Deliveries>("webhook-deliveries.json").deliveries
        assertEquals(2, deliveries.size)
        assertTrue(deliveries.all { it.success == false && it.error == "fetch failed" && it.statusCode == null })
        assertTrue(deliveries.all { it.payload is JsonObject })

        val test = Fixtures.decode<OneDelivery>("webhook-test-delivery.json").delivery
        assertEquals("task.failed", test.event)
        assertEquals(1, test.attempt)
    }

    @Test
    fun workspacesDetailMembersAndLookup() {
        val admin = Fixtures.decode<Workspaces>("workspaces.json").workspaces
        assertEquals(listOf("Android DevLab", "Side project"), admin.map { it.displayName })
        assertEquals(listOf("admin", "admin"), admin.map { it.role })
        assertEquals(listOf("member"), Fixtures.decode<Workspaces>("workspaces-member.json").workspaces.map { it.role })

        val detail = Fixtures.decode<WorkspaceDetail>("workspace.json")
        assertEquals("android-devlab", detail.workspace.slug)
        assertEquals("Seeded by apps/android/e2e", detail.workspace.description)
        assertEquals("admin", detail.role)
        assertEquals("member", Fixtures.decode<WorkspaceDetail>("workspace-member-view.json").role)

        val members = Fixtures.decode<Members>("workspace-members.json").members
        assertEquals(listOf("admin", "member", "viewer"), members.map { it.role })
        assertEquals("Mia Member", members[1].label)

        assertEquals("noor-newcomer@example.com", Fixtures.decode<Lookup>("users-lookup.json").user.email)
    }

    @Test
    fun settingsIntoTheForm() {
        val row = Fixtures.decode<Settings>("optio-settings.json").settings
        val form = AgentSettingsForm.of(row)
        assertEquals(AgentSettingsForm(model = "sonnet", systemPrompt = "", confirmWrites = true, maxTurns = 20), form)
    }

    @Test
    fun claudeStatusRefreshAndProviders() {
        val status = Fixtures.decode<ClaudeAuthStatus>("auth-status.json").subscription
        assertEquals(false, status.available)
        assertEquals(false, status.expired)
        assertNull(status.lastValidated)
        assertEquals("No Claude subscription credentials found on this host", status.error)
        // The refresh answer carries extra authFailures; the status part still decodes.
        assertEquals(false, Fixtures.decode<ClaudeAuthStatus>("auth-refresh.json").subscription.available)

        val providers = Fixtures.decode<AuthProviders>("auth-providers.json")
        assertTrue(providers.providers.isEmpty())
        assertFalse(providers.authDisabled)
    }

    @Test
    fun apiKeys() {
        val keys = Fixtures.decode<Keys>("api-keys.json").keys
        assertEquals(listOf("Android dev lab (admin)", "Pixel 9 emulator"), keys.map { it.name })
        assertEquals("optio_pat_51", keys[0].prefix)
        assertNull(keys[1].lastUsedAt)
        assertNotNull(keys[1].expiresAt)
        val created = Fixtures.decode<CreatedApiKey>("api-key-created.json")
        assertTrue(created.token.startsWith("optio_pat_"))
        assertEquals("A8 fixture key", created.name)
    }

    @Test
    fun notificationPreferencesHaveTheNativePushKeys() {
        val prefs = Fixtures.decode<Preferences>("notification-preferences.json").preferences
        assertEquals(11, prefs.size)
        assertEquals(true, prefs["task.stalled"]?.push, "seeded on")
        assertEquals(false, prefs["agent.turn_completed"]?.push, "seeded off")
        assertTrue(prefs.keys.containsAll(listOf("local.needs_you", "local.host_offline", "agent.failed")))
        assertEquals(true, Fixtures.decode<Preferences>("notification-preferences-updated.json").preferences["task.commented"]?.push)
    }

    @Test
    fun devicesDecodeLocallyAndAsTheGeneratedModel() {
        val devices = Fixtures.decode<PushDevices>("notification-devices.json")
        assertEquals(listOf("ios", "android"), devices.devices.map { it.platform })
        assertEquals(false, devices.push?.fcm)
        val android = devices.devices[1]
        assertTrue(android.isAndroid)
        assertEquals("57db64ed-20d6-47ed-8613-6b5d32f050ca", android.deleteRef, "delete by row id: tokens are masked")
        assertEquals("fake-a…cdef", android.maskedToken, "an already-masked token is shown as listed")
        assertEquals("sandbox", devices.devices[0].environment)

        // The generated model (T) agrees with the real response.
        val generated = OptioJson.decodeFromString<PushDevicesResponse>(Fixtures.text("notification-devices.json"))
        assertEquals(listOf(PushPlatform.IOS, PushPlatform.ANDROID), generated.devices.map { it.platform })
        assertEquals("dev-server", generated.devices[1].serverId)
    }

    @Test
    fun meCarriesTheWorkspaceRole() {
        assertTrue(Fixtures.decode<Me>("auth-me-admin.json").user.isAdmin)
        val member = Fixtures.decode<Me>("auth-me-member.json").user
        assertFalse(member.isAdmin)
        assertTrue(member.canMutate)
        val viewer = Fixtures.decode<Me>("auth-me-viewer.json").user
        assertEquals("viewer", viewer.role)
        assertFalse(viewer.canMutate)
    }

    @Test
    fun olderDeviceRowsWithoutIdOrPlatformStillDecode() {
        val legacy = OptioJson.decodeFromString<PushDevices>(
            """{"devices":[{"deviceToken":"abcdef0123456789abcdef","bundleEnv":"production","deviceName":"Old iPhone"}]}""",
        )
        val row = legacy.devices.single()
        assertNull(legacy.push)
        assertEquals("abcdef…cdef", row.maskedToken)
        assertEquals("abcdef0123456789abcdef", row.deleteRef)
        assertFalse(row.isAndroid)
    }
}
