package dev.optio.feature.more

import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.feature.more.api.NotificationPref
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.api.WebhookCreateInput
import dev.optio.feature.more.api.claudeAuthStatus
import dev.optio.feature.more.api.createApiKey
import dev.optio.feature.more.api.createWebhook
import dev.optio.feature.more.api.deleteSecret
import dev.optio.feature.more.api.deleteWebhook
import dev.optio.feature.more.api.getNotificationPreferences
import dev.optio.feature.more.api.getOptioSettings
import dev.optio.feature.more.api.getWebhook
import dev.optio.feature.more.api.getWorkspace
import dev.optio.feature.more.api.listApiKeys
import dev.optio.feature.more.api.listAuthProviders
import dev.optio.feature.more.api.listPushDevices
import dev.optio.feature.more.api.listSecrets
import dev.optio.feature.more.api.listWebhookDeliveries
import dev.optio.feature.more.api.listWebhooks
import dev.optio.feature.more.api.listWorkspaceMembers
import dev.optio.feature.more.api.listWorkspaces
import dev.optio.feature.more.api.revokeApiKey
import dev.optio.feature.more.api.setWebhookActive
import dev.optio.feature.more.api.testWebhook
import dev.optio.feature.more.api.updateNotificationPreferences
import dev.optio.feature.more.api.upsertSecret
import dev.optio.feature.more.secrets.normalizeSecrets
import dev.optio.feature.more.servers.ServerProbe
import dev.optio.feature.more.workspace.WorkspaceSwitcher
import java.time.Instant
import java.time.temporal.ChronoUnit
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.Serializable
import org.junit.Assume.assumeTrue
import org.junit.Before

/**
 * The More tab's endpoints for real, against a private **auth-enabled** test API
 * (`apps/android/scripts/test-api.sh start --auth --port 4989`). Skipped unless both
 * `OPTIO_TEST_API_URL` and `OPTIO_TEST_TOKEN` (an admin PAT from the instance's seed.json) are
 * set. Every write is undone in `finally`, including the server-side workspace switch.
 *
 * ```
 * SEED=apps/android/e2e/.run/4989/seed.json
 * OPTIO_TEST_API_URL=http://127.0.0.1:4989 OPTIO_TEST_TOKEN=$(node -p "require('./$SEED').auth.adminToken") \
 *   ./gradlew :feature:more:testDebugUnitTest --tests '*LiveMoreApiTest*'
 * ```
 */
class LiveMoreApiTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val token: String? = System.getenv("OPTIO_TEST_TOKEN")
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val tag = "a8live${System.currentTimeMillis() % 1_000_000}"

    @Before
    fun gate() {
        assumeTrue("set OPTIO_TEST_API_URL and OPTIO_TEST_TOKEN to run", baseUrl != null && token != null)
        // Never the user's real Optio (PLAN §1): only a private test API may be written to.
        val port = baseUrl!!.substringAfterLast(':').takeWhile { it.isDigit() }
        check(port !in setOf("30400", "30310")) { "refusing to write to the real Optio on :$port" }
    }

    @AfterTest
    fun tearDown() = scope.cancel()

    private fun api() = ApiClient(baseUrl, token)

    @Test
    fun readsEveryMoreEndpoint() = runBlocking {
        val api = api()
        assertTrue(api.listWorkspaces().isNotEmpty())
        assertNotNull(api.claudeAuthStatus().subscription.available)
        assertFalse(api.listAuthProviders().authDisabled, "an auth-enabled instance")
        assertNotNull(api.getOptioSettings().model)
        val devices = api.listPushDevices()
        assertNotNull(devices.push, "the server says which providers it has")
        assertTrue(devices.devices.all { it.deleteRef != null })
        val ws = api.listWorkspaces().first()
        assertEquals(ws.id, api.getWorkspace(ws.id).workspace.id)
        assertTrue(api.listWorkspaceMembers(ws.id).isNotEmpty())
        assertEquals(ServerProbe.State.ONLINE, ServerProbe.run(api).state)
        assertEquals(ServerProbe.State.UNAUTHORIZED, ServerProbe.run(ApiClient(baseUrl, "optio_pat_not-a-real-token")).state)
    }

    @Test
    fun createAndRevokeAnApiKey() = runBlocking {
        val api = api()
        val created = api.createApiKey("$tag key", Instant.now().plus(7, ChronoUnit.DAYS).truncatedTo(ChronoUnit.SECONDS))
        try {
            assertTrue(created.token.startsWith("optio_pat_"))
            val listed = api.listApiKeys().single { it.id == created.tokenId }
            assertEquals("$tag key", listed.name)
            assertEquals(created.token.take(12), listed.prefix, "the list shows only the prefix")
            assertNotNull(listed.expiresAt)
            // The new token works on its own.
            assertEquals(ServerProbe.State.ONLINE, ServerProbe.run(ApiClient(baseUrl, created.token)).state)
        } finally {
            created.tokenId?.let { api.revokeApiKey(it) }
        }
        assertNull(api.listApiKeys().firstOrNull { it.id == created.tokenId }, "revoked")
        assertEquals(ServerProbe.State.UNAUTHORIZED, ServerProbe.run(ApiClient(baseUrl, created.token)).state)
    }

    @Test
    fun toggleANotificationPreference() = runBlocking {
        val api = api()
        val key = "task.commented"
        val before = api.getNotificationPreferences()[key]?.push ?: false
        try {
            val after = api.updateNotificationPreferences(mapOf(key to NotificationPref(!before)))
            assertEquals(!before, after[key]?.push)
            assertEquals(!before, api.getNotificationPreferences()[key]?.push)
            assertTrue(after.size > 1, "the server merges and answers the whole map")
        } finally {
            api.updateNotificationPreferences(mapOf(key to NotificationPref(before)))
        }
        assertEquals(before, api.getNotificationPreferences()[key]?.push)
    }

    @Test
    fun switchWorkspaceAndBack() = runBlocking {
        val session = SessionStore(ServerRegistry.inMemory(), scope)
        session.addServer(baseUrl!!, token!!, name = "Live")
        val original = session.user.value?.workspaceId ?: session.api.listWorkspaces().first().id
        val switcher = WorkspaceSwitcher(session.api, session)
        switcher.load()
        val other = switcher.workspaces.firstOrNull { it.id != original }
        assumeTrue("needs a second workspace (the --auth seed has \"Side project\")", other != null)
        try {
            assertNull(switcher.switchTo(other!!))
            assertEquals(other.id, session.workspaceId.value)
            assertEquals(other.id, session.user.value?.workspaceId, "the user is re-read in the new workspace")
            // Server-side too: a client with no override now lands in it.
            assertEquals(other.id, ApiClient(baseUrl, token).get<Me>("/api/auth/me").user.workspaceId)
        } finally {
            val back = switcher.workspaces.first { it.id == original }
            assertNull(switcher.switchTo(back))
            session.events.stop()
        }
        assertEquals(original, ApiClient(baseUrl, token).get<Me>("/api/auth/me").user.workspaceId)
    }

    @Test
    fun addAndDeleteAUserSecret() = runBlocking {
        val api = api()
        val name = "${tag.uppercase()}_SECRET"
        try {
            val result = api.upsertSecret(name, "never-shown", SecretRow.SCOPE_USER)
            assertEquals(name, result.name)
            assertEquals("user", result.scope)
            val shown = normalizeSecrets(api.listSecrets(), "all").filter { it.name == name }
            assertEquals(1, shown.size, "listed once although the server repeats user rows")
            assertEquals(1, normalizeSecrets(api.listSecrets("user"), "user").count { it.name == name })
        } finally {
            api.deleteSecret(name, SecretRow.SCOPE_USER)
        }
        assertTrue(api.listSecrets().none { it.name == name })
    }

    @Test
    fun addTestPauseAndDeleteAWebhook() = runBlocking {
        val api = api()
        val hook = api.createWebhook(
            WebhookCreateInput(url = "https://hooks.example.invalid/$tag", events = listOf("task.failed"), secret = "s3cret", description = "$tag hook"),
        )
        try {
            assertTrue(hook.isSigned, "the secret is set (and masked)")
            assertEquals("••••••", hook.secret)
            assertTrue(api.listWebhooks().any { it.id == hook.id })
            val paused = api.setWebhookActive(hook.id, active = false)
            assertTrue(paused.isPaused)
            assertTrue(api.getWebhook(hook.id).isPaused)
            val delivery = api.testWebhook(hook.id, event = null)
            assertEquals("task.failed", delivery.event, "the first subscribed event")
            assertEquals(false, delivery.success, ".invalid never resolves")
            assertTrue(api.listWebhookDeliveries(hook.id).any { it.id == delivery.id })
        } finally {
            api.deleteWebhook(hook.id)
        }
        assertTrue(api.listWebhooks().none { it.id == hook.id })
        val gone = runCatching { api.getWebhook(hook.id) }.exceptionOrNull() as? ApiError
        assertEquals(404, gone?.status)
    }

    @Serializable
    private data class Me(val user: MeUser)

    @Serializable
    private data class MeUser(val workspaceId: String? = null)
}
