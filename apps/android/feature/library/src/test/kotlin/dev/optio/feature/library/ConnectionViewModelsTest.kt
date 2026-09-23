package dev.optio.feature.library

import dev.optio.core.model.get
import dev.optio.core.model.objectValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.connections.AccessControl
import dev.optio.feature.library.connections.ConnectionDetailViewModel
import dev.optio.feature.library.connections.ConnectionsViewModel
import dev.optio.feature.library.connections.NewConnectionViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Rule

/** Connections hub (catalogue, MCP toggles), connection detail and new connection. */
class ConnectionViewModelsTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    private val httpId = "fc8f92a0-163b-40c6-b163-0106f299c754"
    private val httpProviderId = "6df4fd9a-6502-4012-be60-9142dae37e23"

    private fun serveHub() {
        server.fixture("/api/connection-providers", "connection-providers.json")
        server.fixture("/api/connections", "connections.json")
        server.fixture("/api/mcp-servers", "mcp-servers-global.json")
        server.fixture("/api/repos", "repos.json")
    }

    @Test
    fun hubLoadsEverythingAndGroupsTheCatalogue() = runTest(main.dispatcher) {
        serveHub()
        val vm = ConnectionsViewModel(server.client())
        vm.onAppear()
        val catalog = vm.awaitLoaded()
        assertEquals(2, catalog.connections.size)
        assertEquals(9, catalog.providers.size)
        assertEquals("everything", catalog.mcpServers.single().name)
        assertEquals(2, catalog.repos.size)
        assertEquals(listOf("Productivity", "Databases", "Cloud", "Knowledge", "Custom"), catalog.groupedProviders.map { it.first.label })
        assertEquals("global", server.lastRequest("GET", "/api/mcp-servers")!!.queryParam("scope"))
    }

    @Test
    fun hubShowsTheCatalogueWhenOnlyConnectionsFail() = runTest(main.dispatcher) {
        serveHub()
        server.error("GET", "/api/connections", 500, "boom")
        val vm = ConnectionsViewModel(server.client())
        vm.refresh()
        val catalog = vm.awaitLoaded()
        assertEquals(emptyList(), catalog.connections)
        assertEquals(9, catalog.providers.size)
    }

    @Test
    fun hubFailsWhenConnectionsAndTheCatalogueFail() = runTest(main.dispatcher) {
        server.error("GET", "/api/connections", 500, "boom")
        server.error("GET", "/api/connection-providers", 500, "boom")
        val vm = ConnectionsViewModel(server.client())
        vm.refresh()
        assertEquals(500, (vm.awaitFailure() as ApiError).status)
    }

    @Test
    fun mcpToggleIsOptimisticAndRevertsOnFailure() = runTest(main.dispatcher) {
        serveHub()
        server.error("PATCH", "/api/mcp-servers/:id", 403, "Forbidden")
        val vm = ConnectionsViewModel(server.client())
        vm.refresh().join()
        val server0 = vm.state.value.value!!.mcpServers.single()
        val job = vm.setMcpEnabled(server0, false)!!
        assertEquals(false, vm.state.value.value!!.mcpServers.single().enabled, "flipped before the request returns")
        job.join()
        assertEquals(true, vm.state.value.value!!.mcpServers.single().enabled, "reverted after the 403")
        assertEquals(ScreenEvent.Toast("You don't have permission to do that.", Tone.DANGER), vm.nextEvent())
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/mcp-servers/${server0.id}")!!.body)
    }

    @Test
    fun mcpToggleSucceedsAndReloads() = runTest(main.dispatcher) {
        serveHub()
        server.json("/api/mcp-servers/:id", """{"server":{"id":"m"}}""", method = "PATCH")
        val vm = ConnectionsViewModel(server.client())
        vm.refresh().join()
        vm.setMcpEnabled(vm.state.value.value!!.mcpServers.single(), false)!!.join()
        assertEquals(2, server.count("GET", "/api/connections"))
    }

    @Test
    fun hubDeletesConnectionsAndAddsGlobalMcpServers() = runTest(main.dispatcher) {
        serveHub()
        server.on("DELETE", "/api/connections/:id") { FakeResponse.empty() }
        server.json("/api/mcp-servers", """{"server":{"id":"m"}}""", method = "POST", status = 201)
        val vm = ConnectionsViewModel(server.client())
        vm.refresh().join()
        val http = vm.state.value.value!!.connections.first { it.id == httpId }
        vm.deleteConnection(http).join()
        assertEquals(ScreenEvent.Toast("Deleted “Status page API”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(1, server.count("DELETE", "/api/connections/$httpId"))

        var closed = false
        vm.addMcpServer(McpServerInput("fs", "npx")) { closed = true }!!.join()
        assertTrue(closed)
        assertEquals("""{"name":"fs","command":"npx"}""", server.lastRequest("POST", "/api/mcp-servers")!!.body)
    }

    @Test
    fun detailLoadsInlineAssignmentsAndRepos() = runTest(main.dispatcher) {
        server.fixture("/api/connections/:id", "connection-http.json")
        server.fixture("/api/repos", "repos.json")
        val vm = ConnectionDetailViewModel(server.client(), httpId)
        vm.onAppear()
        val detail = vm.awaitLoaded()
        assertEquals("Status page API", detail.connection.name)
        assertEquals("e2e-org/e2e-repo", detail.repoLabel(detail.assignments.single().repoId))
        assertEquals(0, server.count("GET", "/api/connections/:id/assignments"), "inline assignments need no second call")
    }

    @Test
    fun detailFetchesAssignmentsWhenNotInline() = runTest(main.dispatcher) {
        server.json("/api/connections/:id", """{"connection":{"id":"c","name":"Bare"}}""")
        server.fixture("/api/connections/:id/assignments", "connection-assignments.json")
        server.error("GET", "/api/repos", 500, "boom")
        val vm = ConnectionDetailViewModel(server.client(), "c")
        vm.refresh()
        val detail = vm.awaitLoaded()
        assertEquals(1, detail.assignments.size)
        assertEquals(emptyList(), detail.repos)
        assertEquals("Repo 85d784a6", detail.repoLabel(detail.assignments.single().repoId))
    }

    @Test
    fun testToastsTheResult() = runTest(main.dispatcher) {
        server.fixture("/api/connections/:id", "connection-http.json")
        server.fixture("/api/repos", "repos.json")
        server.fixture("/api/connections/:id/test", "connection-test.json", method = "POST")
        val vm = ConnectionDetailViewModel(server.client(), httpId)
        vm.refresh().join()
        vm.test()!!.join()
        assertFalse(vm.busy)
        assertEquals(ScreenEvent.Toast("Healthy: Connection OK", Tone.SUCCESS), vm.nextEvent())

        server.json("/api/connections/:id/test", """{"connection":{"id":"c","status":"error","statusMessage":"401 Unauthorized"}}""", method = "POST")
        vm.test()!!.join()
        assertEquals(ScreenEvent.Toast("Failed: 401 Unauthorized", Tone.DANGER), vm.nextEvent())
    }

    @Test
    fun enableDisableAndDelete() = runTest(main.dispatcher) {
        server.fixture("/api/connections/:id", "connection-http.json")
        server.fixture("/api/repos", "repos.json")
        server.fixture("/api/connections/:id", "connection-http.json", method = "PATCH")
        server.on("DELETE", "/api/connections/:id") { FakeResponse.empty() }
        val vm = ConnectionDetailViewModel(server.client(), httpId)
        vm.refresh().join()
        vm.setEnabled(false)!!.join()
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/connections/$httpId")!!.body)
        assertEquals(ScreenEvent.Toast("Disabled.", Tone.SUCCESS), vm.nextEvent())
        vm.delete()!!.join()
        assertEquals(ScreenEvent.Toast("Deleted “Status page API”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun assignmentsAddAndRemove() = runTest(main.dispatcher) {
        server.fixture("/api/connections/:id", "connection-http.json")
        server.fixture("/api/repos", "repos.json")
        server.json("/api/connections/:id/assignments", """{"assignment":{"id":"a2"}}""", method = "POST", status = 201)
        server.on("DELETE", "/api/connection-assignments/:id") { FakeResponse.empty() }
        val vm = ConnectionDetailViewModel(server.client(), httpId)
        vm.refresh().join()
        var closed = false
        val access = AccessControl(repoId = "aed5dc21-d83e-4428-a39f-a7c235643f9a", permission = "readwrite")
            .toggling("gemini", true).toggling("codex", true)
        vm.addAssignment(access) { closed = true }!!.join()
        assertTrue(closed)
        assertEquals(
            """{"repoId":"aed5dc21-d83e-4428-a39f-a7c235643f9a","agentTypes":["codex","gemini"],"permission":"readwrite"}""",
            server.lastRequest("POST", "/api/connections/$httpId/assignments")!!.body,
        )
        vm.deleteAssignment(vm.state.value.value!!.assignments.single()).join()
        assertEquals(1, server.count("DELETE", "/api/connection-assignments/af3e95fe-9f5a-49a2-93f3-24888a4e174c"))
    }

    @Test
    fun newConnectionNamesItselfAndNeedsRequiredFields() = runTest(main.dispatcher) {
        server.fixture("/api/connection-providers", "connection-providers.json")
        server.fixture("/api/repos", "repos.json")
        server.fixture("/api/connections", "connection-http.json", method = "POST", status = 201)
        val vm = NewConnectionViewModel(server.client(), httpProviderId)
        vm.loadOnce()
        val data = vm.awaitLoaded()
        assertEquals("HTTP API", data.provider.name)
        assertEquals("My HTTP API", vm.name)
        assertFalse(vm.canSave(data.provider), "baseUrl is required")

        vm.config["baseUrl"] = "https://status.example.com"
        vm.config["authType"] = "bearer"
        vm.config["AUTH_TOKEN"] = "s3cret"
        vm.config["description"] = ""
        vm.toggleReveal("AUTH_TOKEN")
        assertEquals(true, vm.revealed["AUTH_TOKEN"])
        vm.access = AccessControl().toggling("claude-code", true)
        assertTrue(vm.canSave(data.provider))
        vm.save()!!.join()

        val body = server.lastRequest("POST", "/api/connections")!!.json
        assertEquals(httpProviderId, body["providerId"]?.stringValue)
        assertEquals("My HTTP API", body["name"]?.stringValue)
        assertEquals(
            mapOf("baseUrl" to "https://status.example.com", "authType" to "bearer", "AUTH_TOKEN" to "s3cret"),
            body["config"]!!.objectValue!!.mapValues { it.value.stringValue },
            "empty values are left out",
        )
        assertEquals("""[{"agentTypes":["claude-code"],"permission":"read"}]""", body["assignments"].toString())
        assertTrue(vm.config.isEmpty(), "secrets are dropped once sent")
        assertEquals(ScreenEvent.Toast("Added “Status page API”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun newConnectionKeepsATypedNameAndReportsAnUnknownProvider() = runTest(main.dispatcher) {
        server.fixture("/api/connection-providers", "connection-providers.json")
        server.fixture("/api/repos", "repos.json")
        val vm = NewConnectionViewModel(server.client(), "nope")
        vm.refresh()
        assertEquals(ApiError.NOT_FOUND, (vm.awaitFailure() as ApiError).status)

        val named = NewConnectionViewModel(server.client(), httpProviderId)
        named.name = "Ops status"
        named.refresh().join()
        assertEquals("Ops status", named.name)
    }

    @Test
    fun newConnectionAsAMemberToastsAndKeepsTheForm() = runTest(main.dispatcher) {
        server.fixture("/api/connection-providers", "connection-providers.json")
        server.fixture("/api/repos", "repos.json")
        server.error("POST", "/api/connections", 403, "Forbidden")
        val vm = NewConnectionViewModel(server.client(), httpProviderId)
        vm.refresh().join()
        vm.config["baseUrl"] = "https://x"
        vm.save()!!.join()
        assertEquals(ScreenEvent.Toast("You don't have permission to do that.", Tone.DANGER), vm.nextEvent())
        assertEquals("https://x", vm.config["baseUrl"])
        assertFalse(vm.saving)
    }
}
