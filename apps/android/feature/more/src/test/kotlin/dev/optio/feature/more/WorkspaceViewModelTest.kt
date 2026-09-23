package dev.optio.feature.more

import dev.optio.core.data.ServerRegistry
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.ui.Notice
import dev.optio.feature.more.workspace.WorkspaceForm
import dev.optio.feature.more.workspace.WorkspaceSettingsViewModel
import dev.optio.feature.more.workspace.WorkspaceSwitcher
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Rule

/** The workspace screen and the workspace switcher against the fake API and a real SessionStore. */
class WorkspaceViewModelTest {
    @get:Rule(order = 0)
    val main = MainDispatcherRule()

    @get:Rule(order = 1)
    val fake = FakeOptioServerRule()

    @get:Rule(order = 2)
    val vms = ViewModelsRule()

    private val server get() = fake.server
    private val sessionScope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    private val session = SessionStore(ServerRegistry.inMemory(), sessionScope)

    @AfterTest
    fun tearDown() {
        session.events.stop()
        sessionScope.cancel()
    }

    private suspend fun awaitRequest(
        method: String,
        path: String,
    ) = withContext(Dispatchers.Default) { server.awaitRequest(method, path) }

    private fun serveWorkspace() {
        server.fixture("/api/workspaces", "workspaces.json")
        server.fixture("/api/workspaces/:id", "workspace.json")
        server.fixture("/api/workspaces/:id/members", "workspace-members.json")
    }

    // region Workspace settings

    @Test
    fun loadsTheWorkspaceItsRoleAndMembers() = runTest(main.dispatcher) {
        serveWorkspace()
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        val data = assertNotNull(vm.state.value.value)
        assertTrue(data.isAdmin)
        assertEquals(listOf("Ada Admin", "Mia Member", "Vic Viewer"), data.members.map { it.label })
        assertEquals(WorkspaceForm("Android DevLab", "android-devlab", "Seeded by apps/android/e2e"), vm.form.value)
        assertNull(server.lastRequest("GET", "/api/workspaces"), "an explicit id needs no list")
    }

    @Test
    fun withoutAnIdTheFirstListedWorkspaceLoads() = runTest(main.dispatcher) {
        serveWorkspace()
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(null)
        assertEquals(WS, server.lastRequest("GET", "/api/workspaces/:id")!!.pathParams["id"])
        assertEquals("android-devlab", vm.state.value.value!!.workspace.slug)
    }

    @Test
    fun noWorkspaceAtAllIsAnError() = runTest(main.dispatcher) {
        server.json("/api/workspaces", """{"workspaces":[]}""")
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(null)
        assertEquals("No workspace selected", vm.state.value.errorOrNull?.message)
    }

    @Test
    fun aMemberSeesItReadOnlyAndMembersFailingStillShowsIt() = runTest(main.dispatcher) {
        server.fixture("/api/workspaces/:id", "workspace-member-view.json")
        server.error("GET", "/api/workspaces/:id/members", 500, "boom")
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        val data = vm.state.value.value!!
        assertFalse(data.isAdmin)
        assertTrue(data.members.isEmpty())
    }

    @Test
    fun saveSendsTheFormAndClearsAnEmptyDescription() = runTest(main.dispatcher) {
        serveWorkspace()
        server.patch("/api/workspaces/:id") { FakeResponse.fixture("workspace.json") }
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        vm.editForm { it.copy(name = " DevLab ", description = "") }
        vm.save()
        assertEquals(Notice("Workspace updated.", Tone.SUCCESS), vm.notices.first())
        val body = server.lastRequest("PATCH", "/api/workspaces/:id")!!.json.jsonObject
        assertEquals("DevLab", body["name"]!!.jsonPrimitive.content)
        assertEquals("android-devlab", body["slug"]!!.jsonPrimitive.content)
        assertEquals(JsonNull, body["description"], "an emptied description is cleared")
        assertNull(vm.busy.value)
    }

    @Test
    fun inviteLooksTheUserUpThenAddsThem() = runTest(main.dispatcher) {
        serveWorkspace()
        server.fixture("/api/users/lookup", "users-lookup.json")
        server.post("/api/workspaces/:id/members") { FakeResponse.json("""{"ok":true}""", 201) }
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        val done = CompletableDeferred<Unit>()
        vm.invite(" noor-newcomer@example.com ", "viewer") { done.complete(Unit) }
        assertEquals(Notice("Noor Newcomer added to workspace.", Tone.SUCCESS), vm.notices.first())
        assertTrue(done.isCompleted, "the email field clears")
        assertEquals("noor-newcomer@example.com", server.lastRequest("GET", "/api/users/lookup")!!.queryParam("email"))
        val body = server.lastRequest("POST", "/api/workspaces/:id/members")!!.json.jsonObject
        assertEquals("6dba55c8-21bb-4481-8907-18af6f35e3b1", body["userId"]!!.jsonPrimitive.content)
        assertEquals("viewer", body["role"]!!.jsonPrimitive.content)
    }

    @Test
    fun inviteReportsTheServersReason() = runTest(main.dispatcher) {
        serveWorkspace()
        server.error("GET", "/api/users/lookup", 404, "User not found")
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        var done = false
        vm.invite("nobody@example.com", "member") { done = true }
        assertEquals(Notice("User not found", Tone.DANGER), vm.notices.first())
        assertFalse(done)
        assertNull(server.lastRequest("POST", "/api/workspaces/:id/members"))
    }

    @Test
    fun changeRoleAndRemoveAMember() = runTest(main.dispatcher) {
        serveWorkspace()
        server.patch("/api/workspaces/:id/members/:userId") { FakeResponse.json("""{"ok":true}""") }
        server.delete("/api/workspaces/:id/members/:userId") { FakeResponse.empty() }
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        val mia = vm.state.value.value!!.members[1]
        vm.changeRole(mia, "member")
        assertNull(server.lastRequest("PATCH"), "the same role is not sent")

        server.clearRequests()
        vm.changeRole(mia, "viewer")
        awaitRequest("GET", "/api/workspaces/:id/members")
        vm.state.first { it is LoadState.Loaded }
        val patch = server.lastRequest("PATCH", "/api/workspaces/:id/members/:userId")!!
        assertEquals(mia.userId, patch.pathParams["userId"])
        assertEquals("viewer", patch.json.jsonObject["role"]!!.jsonPrimitive.content)

        server.clearRequests()
        vm.remove(mia)
        awaitRequest("GET", "/api/workspaces/:id/members")
        vm.state.first { it is LoadState.Loaded }
        assertEquals(mia.userId, server.lastRequest("DELETE", "/api/workspaces/:id/members/:userId")!!.pathParams["userId"])
    }

    @Test
    fun deleteDropsTheOverrideAndCallsBack() = runTest(main.dispatcher) {
        serveWorkspace()
        server.delete("/api/workspaces/:id") { FakeResponse.empty() }
        session.setWorkspaceId(WS)
        val vm = vms.of { WorkspaceSettingsViewModel(server.client(), session) }
        vm.load(WS)
        val deleted = CompletableDeferred<Unit>()
        vm.delete { deleted.complete(Unit) }
        deleted.await()
        assertEquals(WS, server.lastRequest("DELETE", "/api/workspaces/:id")!!.pathParams["id"])
        assertNull(session.workspaceId.value, "the deleted workspace is no longer the override")
    }

    // endregion

    // region Switcher

    @Test
    fun switchingPostsTheSwitchAndPointsTheSessionAtTheWorkspace() = runBlocking {
        serveWorkspace()
        server.json("/api/auth/me", """{"user":{"id":"u1","email":"ada-admin@example.com","displayName":"Ada Admin","workspaceId":"$WS","workspaceRole":"admin"},"authDisabled":false}""")
        server.webSocket("/ws/events")
        server.post("/api/workspaces/:id/switch") { FakeResponse.json("""{"ok":true}""") }
        session.addServer(server.baseUrl, "optio_pat_test", name = "DevLab")
        val switcher = WorkspaceSwitcher(session.api, session)
        switcher.load()
        assertEquals(listOf("Android DevLab", "Side project"), switcher.workspaces.map(WorkspaceRow::displayName))
        assertFalse(switcher.loading)

        server.clearRequests()
        assertNull(switcher.switchTo(switcher.workspaces[1]))
        assertEquals(WS2, server.lastRequest("POST", "/api/workspaces/:id/switch")!!.pathParams["id"])
        assertEquals(WS2, session.workspaceId.value)
        assertEquals(WS2, session.api.workspaceId, "every request now sends x-workspace-id")
        assertEquals(WS2, server.lastRequest("GET", "/api/auth/me")!!.header("x-workspace-id"), "the user is re-read in the new workspace")
        assertEquals(WS2, session.registry.active()?.workspaceId, "persisted on the server profile")
        assertNull(switcher.switching)
    }

    @Test
    fun aRefusedSwitchChangesNothing() = runBlocking {
        server.fixture("/api/workspaces", "workspaces.json")
        server.error("POST", "/api/workspaces/:id/switch", 403, "Not a member of this workspace")
        val switcher = WorkspaceSwitcher(server.client(), session)
        switcher.load()
        val error = switcher.switchTo(switcher.workspaces[1])
        assertEquals(403, (error as ApiError).status)
        assertNull(session.workspaceId.value)
    }

    @Test
    fun theSwitcherOnAnAuthDisabledServer() = runBlocking {
        server.error("GET", "/api/workspaces", 401, "Authentication required")
        val switcher = WorkspaceSwitcher(server.client(), session)
        switcher.load()
        assertTrue(switcher.workspaces.isEmpty())
        assertEquals(401, (switcher.loadError as ApiError).status)
    }

    // endregion

    private companion object {
        const val WS = "35802f88-a258-4eca-9817-be325718ab9e"
        const val WS2 = "4a94e89e-13c5-44b9-996b-75d08dcb58e0"
    }
}
