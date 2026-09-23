package dev.optio.feature.more

import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.PushDeviceRow
import dev.optio.feature.more.settings.ApiKeysViewModel
import dev.optio.feature.more.settings.NotificationDevicesViewModel
import dev.optio.feature.more.settings.NotificationPrefsViewModel
import dev.optio.feature.more.settings.OptioAgentSettingsViewModel
import dev.optio.feature.more.settings.SettingsViewModel
import dev.optio.feature.more.ui.Notice
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Rule

/** Settings, tokens, preferences, agent settings and devices ViewModels against the fake API. */
class SettingsViewModelsTest {
    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val fake = FakeOptioServerRule()

    @get:Rule(order = 2)
    val vms = ViewModelsRule()

    private val server get() = fake.server

    private suspend fun awaitRequest(
        method: String,
        path: String,
    ) = withContext(Dispatchers.Default) { server.awaitRequest(method, path) }

    // region Settings (Claude status, providers, refresh)

    @Test
    fun settingsLoadStatusAndProvidersThenRefresh() = runTest(main.dispatcher) {
        server.fixture("/api/auth/status", "auth-status.json")
        server.json("/api/auth/providers", """{"providers":[{"name":"github","displayName":"GitHub"}],"authDisabled":false}""")
        server.fixture("/api/auth/refresh", "auth-refresh.json", method = "POST")
        val vm = vms.of { SettingsViewModel(server.client()) }
        val status = vm.claude.first { it is LoadState.Loaded }.value!!
        assertEquals(false, status.available)
        assertEquals(listOf("github"), vm.providers.first { it != null }!!.providers.map { it.name })

        server.clearRequests()
        vm.refreshClaude()
        assertTrue(vm.refreshing.value)
        vm.refreshing.first { !it }
        assertEquals(listOf("POST /api/auth/refresh", "GET /api/auth/status", "GET /api/auth/providers"), server.requests.map { "${it.method} ${it.path}" })
    }

    @Test
    fun settingsRefreshIsAdminOnly() = runTest(main.dispatcher) {
        server.fixture("/api/auth/status", "auth-status.json")
        server.fixture("/api/auth/providers", "auth-providers.json")
        server.error("POST", "/api/auth/refresh", 403, "Forbidden: requires admin role")
        val vm = vms.of { SettingsViewModel(server.client()) }
        vm.claude.first { it is LoadState.Loaded }
        vm.providers.first { it != null }
        vm.refreshClaude()
        assertEquals(Notice("You don't have permission to do that. Forbidden: requires admin role", Tone.DANGER), vm.notices.first())
    }

    @Test
    fun settingsStatusFailureKeepsProvidersOptional() = runTest(main.dispatcher) {
        server.error("GET", "/api/auth/status", 500, "boom")
        server.error("GET", "/api/auth/providers", 500, "boom")
        val vm = vms.of { SettingsViewModel(server.client()) }
        val failed = vm.claude.first { it is LoadState.Failed }
        assertNotNull(failed.errorOrNull)
        assertNull(vm.providers.value)
    }

    // endregion

    // region Access tokens

    @Test
    fun apiKeysCreateShowsTheTokenOnceThenReloads() = runTest(main.dispatcher) {
        server.fixture("/api/auth/api-keys", "api-keys.json")
        server.post("/api/auth/api-keys") { FakeResponse.fixture("api-key-created.json", 201) }
        val vm = vms.of { ApiKeysViewModel(server.client(token = "optio_pat_51abcdef")) }
        vm.load()
        assertEquals(2, vm.state.value.value!!.size)
        assertEquals("optio_pat_51abcdef", vm.currentToken, "the row whose prefix matches is this app")

        val expires = Instant.parse("2026-12-21T16:40:00Z")
        vm.create("  ", defaultName = "Android (Pixel 10)", expiresAt = expires)
        val created = vm.created.first { it != null }!!
        assertTrue(created.token.startsWith("optio_pat_"))
        val body = server.lastRequest("POST", "/api/auth/api-keys")!!.json.jsonObject
        assertEquals("Android (Pixel 10)", body["name"]!!.jsonPrimitive.content, "a blank name takes the device default")
        assertEquals("2026-12-21T16:40:00Z", body["expiresAt"]!!.jsonPrimitive.content)
        vm.creating.first { !it }

        server.clearRequests()
        vm.finishCreate()
        assertNull(vm.created.value, "Done forgets the token")
        awaitRequest("GET", "/api/auth/api-keys")
        vm.state.first { it is LoadState.Loaded }
    }

    @Test
    fun apiKeysNoExpiryOmitsTheField() = runTest(main.dispatcher) {
        server.post("/api/auth/api-keys") { FakeResponse.fixture("api-key-created.json", 201) }
        val vm = vms.of { ApiKeysViewModel(server.client()) }
        vm.create("CLI laptop", defaultName = "unused", expiresAt = null)
        vm.created.first { it != null }
        val body = server.lastRequest("POST", "/api/auth/api-keys")!!.json.jsonObject
        assertEquals("CLI laptop", body["name"]!!.jsonPrimitive.content)
        assertFalse("expiresAt" in body)
        vm.creating.first { !it }
    }

    @Test
    fun apiKeysRevokeDeletesByIdAndReloads() = runTest(main.dispatcher) {
        server.fixture("/api/auth/api-keys", "api-keys.json")
        server.delete("/api/auth/api-keys/:id") { FakeResponse.json("""{"ok":true}""") }
        val vm = vms.of { ApiKeysViewModel(server.client()) }
        vm.load()
        val extra = vm.state.value.value!![1]
        server.clearRequests()
        vm.revoke(extra)
        awaitRequest("GET", "/api/auth/api-keys")
        vm.state.first { it is LoadState.Loaded }
        assertEquals("2394e0d4-7800-47bf-85d9-ff991b6a3e4d", server.lastRequest("DELETE", "/api/auth/api-keys/:id")!!.pathParams["id"])
    }

    @Test
    fun apiKeysOnAnAuthDisabledServerAnswer401() = runTest(main.dispatcher) {
        server.error("GET", "/api/auth/api-keys", 401, "Not authenticated")
        val vm = vms.of { ApiKeysViewModel(server.client()) }
        vm.load()
        assertEquals(401, (vm.state.value.errorOrNull as ApiError).status)
    }

    // endregion

    // region Notification preferences

    @Test
    fun preferenceToggleIsOptimisticAndTakesTheServersMap() = runTest(main.dispatcher) {
        server.fixture("/api/notifications/preferences", "notification-preferences.json")
        server.put("/api/notifications/preferences") {
            FakeResponse.json("""{"preferences":{"task.commented":{"push":true},"task.stalled":{"push":false}}}""")
        }
        val vm = vms.of { NotificationPrefsViewModel(server.client()) }
        vm.load()
        assertEquals(false, vm.state.value.value!!["task.commented"]?.push)
        vm.set("task.commented", true)
        assertEquals(true, vm.state.value.value!!["task.commented"]?.push, "flipped before the server answers")
        awaitRequest("PUT", "/api/notifications/preferences")
        val body = server.lastRequest("PUT", "/api/notifications/preferences")!!.json.jsonObject
        assertEquals(setOf("task.commented"), body.keys, "only the toggled key is sent")
        assertEquals("true", body["task.commented"]!!.jsonObject["push"]!!.jsonPrimitive.content)
        vm.state.first { it.value?.size == 2 }
        assertEquals(false, vm.state.value.value!!["task.stalled"]?.push, "the server's merged map replaces ours")
    }

    @Test
    fun preferenceToggleRevertsOnFailure() = runTest(main.dispatcher) {
        server.fixture("/api/notifications/preferences", "notification-preferences.json")
        server.error("PUT", "/api/notifications/preferences", 500, "boom")
        val vm = vms.of { NotificationPrefsViewModel(server.client()) }
        vm.load()
        vm.set("agent.failed", false)
        assertEquals(false, vm.state.value.value!!["agent.failed"]?.push)
        assertEquals(Tone.DANGER, vm.notices.first().tone)
        assertEquals(true, vm.state.value.value!!["agent.failed"]?.push, "reverted")
    }

    // endregion

    // region Optio agent settings

    @Test
    fun agentSettingsLoadEditSave() = runTest(main.dispatcher) {
        server.fixture("/api/optio/settings", "optio-settings.json")
        server.put("/api/optio/settings") { req ->
            val sent = req.json.jsonObject
            FakeResponse.json("""{"settings":{"model":"${sent["model"]!!.jsonPrimitive.content}","systemPrompt":"Be brief.","enabledTools":[],"confirmWrites":false,"maxTurns":25}}""")
        }
        val vm = vms.of { OptioAgentSettingsViewModel(server.client()) }
        vm.state.first { it is LoadState.Loaded }
        assertEquals("sonnet", vm.form.value.model)

        vm.edit { it.copy(model = "opus", systemPrompt = "Be brief.", confirmWrites = false, maxTurns = 25, reviewAgentType = "", reviewModel = "") }
        assertFalse(vm.saved.value)
        vm.save()
        assertEquals(Notice("Saved", Tone.SUCCESS), vm.notices.first())
        assertTrue(vm.saved.value)
        assertEquals("opus", vm.form.value.model)
        val body = server.lastRequest("PUT", "/api/optio/settings")!!.json.jsonObject
        assertEquals("25", body["maxTurns"]!!.jsonPrimitive.content)
        assertEquals("false", body["confirmWrites"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, body["defaultReviewAgentType"])
        assertFalse("enabledTools" in body)

        vm.edit { it.copy(maxTurns = 26) }
        assertFalse(vm.saved.value, "an edit after saving re-arms Save")
    }

    @Test
    fun agentSettingsSaveIsAdminOnly() = runTest(main.dispatcher) {
        server.fixture("/api/optio/settings", "optio-settings.json")
        server.error("PUT", "/api/optio/settings", 403, "Forbidden: requires admin role")
        val vm = vms.of { OptioAgentSettingsViewModel(server.client()) }
        vm.state.first { it is LoadState.Loaded }
        vm.save()
        assertEquals("You don't have permission to do that. Forbidden: requires admin role", vm.notices.first().text)
        assertFalse(vm.saved.value)
        vm.saving.first { !it }
    }

    // endregion

    // region Devices

    @Test
    fun devicesRemoveByRowIdAndSendTest() = runTest(main.dispatcher) {
        server.fixture("/api/notifications/devices", "notification-devices.json")
        server.delete("/api/notifications/devices/:ref") { FakeResponse.empty() }
        server.post("/api/notifications/devices/test") { FakeResponse.json("""{"sent":2}""") }
        val vm = vms.of { NotificationDevicesViewModel(server.client()) }
        vm.load()
        val android = vm.state.value.value!!.devices.single { it.isAndroid }
        vm.remove(android)
        vm.state.first { it.value?.devices?.size == 1 }
        assertEquals("57db64ed-20d6-47ed-8613-6b5d32f050ca", server.lastRequest("DELETE", "/api/notifications/devices/:ref")!!.pathParams["ref"])

        vm.sendTest()
        assertEquals(Notice("Sent a test to 2 devices.", Tone.SUCCESS), vm.notices.first())
        vm.sending.first { !it }
    }

    @Test
    fun devicesTestWithoutProvidersShowsTheServersReason() = runTest(main.dispatcher) {
        server.fixture("/api/notifications/devices/test", "notification-devices-test-503.json", method = "POST", status = 503)
        val vm = vms.of { NotificationDevicesViewModel(server.client()) }
        vm.sendTest()
        assertEquals(Notice("Push not configured (APNs for iOS, FCM for Android)", Tone.DANGER), vm.notices.first())
        vm.sending.first { !it }
    }

    @Test
    fun devicesRowWithoutAnyRefIsNotSent() = runTest(main.dispatcher) {
        val vm = vms.of { NotificationDevicesViewModel(server.client()) }
        vm.remove(PushDeviceRow(deviceName = "Ghost"))
        assertEquals(0, server.count("DELETE"))
    }

    // endregion

    // region Hub

    @Test
    fun hubWorkspaceNameByIdThenFallsBackToTheList() = runTest(main.dispatcher) {
        server.fixture("/api/workspaces/:id", "workspace.json")
        server.fixture("/api/workspaces", "workspaces.json")
        assertEquals("Android DevLab", resolveWorkspaceName(server.client(), "35802f88-a258-4eca-9817-be325718ab9e"))
        server.error("GET", "/api/workspaces/:id", 403, "Not a member of this workspace")
        assertEquals("Android DevLab", resolveWorkspaceName(server.client(), "stale-id"), "falls back to the first listed")
        server.error("GET", "/api/workspaces", 401, "Authentication required")
        assertNull(resolveWorkspaceName(server.client(), null))
    }

    @Test
    fun hubSkipsWorkspacesOnAuthDisabledServers() = runTest(main.dispatcher) {
        val vm = vms.of { MoreHubViewModel(server.client()) }
        vm.loadWorkspaceName("anything", authDisabled = true)
        assertNull(vm.workspaceName.value)
        assertEquals(0, server.requests.size, "no guaranteed 401s")
        server.fixture("/api/workspaces/:id", "workspace.json")
        vm.loadWorkspaceName("35802f88-a258-4eca-9817-be325718ab9e", authDisabled = false)
        assertEquals("Android DevLab", vm.workspaceName.value)
    }

    // endregion
}
