package dev.optio.feature.library

import dev.optio.core.model.get
import dev.optio.core.model.isNull
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Rule

/**
 * The Library endpoints against JSON captured from the DevLab test API (`fixtures/`, auth
 * disabled, DevLab seed): paths, methods, bodies, and that every captured shape decodes.
 */
class LibraryApiTest {
    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server
    private val api get() = server.client()

    @Test
    fun promptTemplatesDecode() = runTest {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        val templates = api.listPromptTemplates()
        assertEquals(listOf("prompt", "task", "job", "review"), templates.map { it.kind })
        val flag = templates.first { it.kind == "task" }
        assertEquals("Add a feature flag", flag.name)
        assertEquals(listOf("flag", "owner"), flag.paramNames)
        assertEquals(false, flag.isDefault)
        assertNull(flag.paramsSchema)
        assertEquals("2026-09-23T00:45:57.078Z", flag.updatedAt)
        assertNull(server.lastRequest("GET", "/api/prompt-templates")!!.queryParam("kind"))
    }

    @Test
    fun promptKindFilterIsAQuery() = runTest {
        server.json("/api/prompt-templates", """{"templates":[]}""")
        api.listPromptTemplates(kind = "job")
        assertEquals("job", server.lastRequest("GET", "/api/prompt-templates")!!.queryParam("kind"))
    }

    @Test
    fun createUpdateDeleteAndPreviewPrompts() = runTest {
        val row = """{"template":{"id":"t1","name":"N","template":"B","kind":"job"}}"""
        server.json("/api/prompt-templates/named", row, method = "POST", status = 201)
        server.json("/api/prompt-templates/t1", row, method = "PATCH")
        server.on("DELETE", "/api/prompt-templates/t1") { FakeResponse.empty() }
        server.fixture("/api/prompt-templates/t1/preview", "prompt-preview.json", method = "POST")

        val input = PromptTemplateInput(name = "N", template = "B", kind = "job", description = "d")
        assertEquals("t1", api.createPromptTemplate(input).id)
        assertEquals("""{"name":"N","template":"B","kind":"job","description":"d"}""", server.lastRequest("POST", "/api/prompt-templates/named")!!.body)

        api.updatePromptTemplate("t1", input.copy(description = null))
        val patch = server.lastRequest("PATCH", "/api/prompt-templates/t1")!!.json as JsonObject
        assertTrue(patch.getValue("description").isNull)
        assertTrue(patch.getValue("defaultAgentType").isNull)

        api.deletePromptTemplate("t1")
        assertEquals(1, server.count("DELETE", "/api/prompt-templates/t1"))

        val rendered = api.previewPromptTemplate("t1", mapOf("flag" to "dark-mode", "owner" to "ada"))
        assertEquals("Add a feature flag named dark-mode owned by ada, default off, and open a PR.", rendered)
        assertEquals("""{"params":{"flag":"dark-mode","owner":"ada"}}""", server.lastRequest("POST", "/api/prompt-templates/t1/preview")!!.body)
    }

    @Test
    fun reposDecode() = runTest {
        server.fixture("/api/repos", "repos.json")
        server.fixture("/api/repos/:id", "repo.json")
        val repos = api.listRepos()
        assertEquals(listOf("e2e-org/e2e-repo", "e2e-org/mobile-app"), repos.map { it.displayName })
        val repo = api.getRepo("85d784a6-338f-4675-9070-2890f6855cab")
        assertEquals(6, repo.maxConcurrentTasks)
        assertEquals("claude-code", repo.effectiveReviewAgentType)
        assertEquals("sonnet", repo.effectiveReviewModel)
        assertNull(repo.maxTurnsCoding)
        assertEquals("unrestricted", repo.networkPolicy)
    }

    @Test
    fun repoSubResourcesDecode() = runTest {
        server.fixture("/api/repos/:id/connections", "repo-connections.json")
        server.fixture("/api/repos/:id/mcp-servers", "repo-mcp-servers.json")
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories.json")
        assertEquals(emptyList(), api.listRepoConnections("r"))
        val servers = api.listRepoMcpServers("r")
        assertEquals("npx -y @modelcontextprotocol/server-everything", servers.single().commandLine)
        assertTrue(servers.single().isGlobal)
        val dir = api.listSharedDirectories("r").single()
        assertEquals("npm-cache", dir.name)
        assertEquals(10, dir.sizeGi)
        assertEquals("home", dir.mountLocation)
        assertEquals("2026-09-23T00:47:05.526Z", dir.lastClearedAt)
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories-empty.json")
        assertEquals(emptyList(), api.listSharedDirectories("r"))
    }

    @Test
    fun repoActions() = runTest {
        server.json("/api/repos", """{"repo":{"id":"new","fullName":"o/r"}}""", method = "POST", status = 201)
        server.json("/api/repos/:id", """{"repo":{"id":"new"}}""", method = "PATCH")
        server.on("DELETE", "/api/repos/:id") { FakeResponse.empty() }
        server.fixture("/api/repos/:id/pods/recycle", "recycle.json", method = "POST")
        server.fixture("/api/setup/validate/repo", "validate-repo.json", method = "POST")

        assertEquals("new", api.createRepo(RepoCreateInput("https://github.com/o/r", "o/r", "main", false)).id)
        assertEquals(
            """{"repoUrl":"https://github.com/o/r","fullName":"o/r","defaultBranch":"main","isPrivate":false}""",
            server.lastRequest("POST", "/api/repos")!!.body,
        )
        api.updateRepo("new", mapOf("reviewAgentType" to null, "maxConcurrentTasks" to 3))
        assertEquals("""{"reviewAgentType":null,"maxConcurrentTasks":3}""", server.lastRequest("PATCH", "/api/repos/new")!!.body)
        api.deleteRepo("new")
        assertEquals(1, api.recycleRepoPods("new"))

        val validation = api.validateRepo("https://github.com/e2e-org/not-a-real-repo")
        assertEquals(false, validation.valid)
        assertEquals("Repository not accessible (401)", validation.error)
        assertEquals("""{"repoUrl":"https://github.com/e2e-org/not-a-real-repo"}""", server.lastRequest("POST", "/api/setup/validate/repo")!!.body)
    }

    @Test
    fun sharedDirectoryActions() = runTest {
        server.fixture("/api/repos/:id/shared-directories", "shared-directory-created.json", method = "POST", status = 201)
        server.on("DELETE", "/api/repos/:id/shared-directories/:dir") { FakeResponse.empty() }
        server.json("/api/repos/:id/shared-directories/:dir/clear", """{"ok":true}""", method = "POST")
        server.json("/api/repos/:id/shared-directories/:dir/usage", """{"usage":null}""", method = "POST")

        api.createSharedDirectory("r", SharedDirectoryInput("npm-cache", null, "home", ".npm", 10))
        assertEquals(
            """{"name":"npm-cache","mountLocation":"home","mountSubPath":".npm","sizeGi":10}""",
            server.lastRequest("POST", "/api/repos/r/shared-directories")!!.body,
        )
        api.clearSharedDirectory("r", "d")
        api.deleteSharedDirectory("r", "d")
        assertNull(api.sharedDirectoryUsage("r", "d"))
        server.json("/api/repos/:id/shared-directories/:dir/usage", """{"usage":"1.2G"}""", method = "POST")
        assertEquals("1.2G", api.sharedDirectoryUsage("r", "d"))
    }

    @Test
    fun mcpServers() = runTest {
        server.fixture("/api/mcp-servers", "mcp-servers-global.json")
        server.json("/api/mcp-servers", """{"server":{"id":"m"}}""", method = "POST", status = 201)
        server.json("/api/repos/:id/mcp-servers", """{"server":{"id":"m"}}""", method = "POST", status = 201)
        server.json("/api/mcp-servers/:id", """{"server":{"id":"m","enabled":false}}""", method = "PATCH")
        server.on("DELETE", "/api/mcp-servers/:id") { FakeResponse.empty() }

        assertEquals("everything", api.listMcpServers(scope = "global").single().name)
        assertEquals("global", server.lastRequest("GET", "/api/mcp-servers")!!.queryParam("scope"))
        val input = McpServerInput(name = "fs", command = "npx", args = listOf("-y"), env = mapOf("A" to "b"))
        api.createMcpServer(input)
        assertEquals("""{"name":"fs","command":"npx","args":["-y"],"env":{"A":"b"}}""", server.lastRequest("POST", "/api/mcp-servers")!!.body)
        api.createRepoMcpServer("r", input.copy(env = null))
        assertEquals("""{"name":"fs","command":"npx","args":["-y"]}""", server.lastRequest("POST", "/api/repos/r/mcp-servers")!!.body)
        api.setMcpServerEnabled("m", false)
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/mcp-servers/m")!!.body)
        api.deleteMcpServer("m")
        assertEquals(1, server.count("DELETE", "/api/mcp-servers/m"))
    }

    @Test
    fun connectionProvidersDecode() = runTest {
        server.fixture("/api/connection-providers", "connection-providers.json")
        val providers = api.listConnectionProviders()
        assertEquals(9, providers.size)
        val notion = providers.first { it.slug == "notion" }
        assertEquals(listOf("NOTION_API_KEY"), notion.requiredSecrets)
        assertEquals(listOf("search_pages", "read_page", "list_databases", "query_database"), notion.capabilities)
        assertTrue(notion.configFields.single().isSecret)
        assertEquals(true, notion.builtIn)
        assertEquals("custom", providers.first { it.slug == "custom-mcp" }.category)
    }

    @Test
    fun connectionsDecodeWithoutTheirConfig() = runTest {
        server.fixture("/api/connections", "connections.json")
        server.fixture("/api/connections/:id", "connection-http.json")
        server.fixture("/api/connections/:id/assignments", "connection-assignments.json")
        val connections = api.listConnections()
        assertEquals(setOf("Docs filesystem", "Status page API"), connections.map { it.name }.toSet())
        val filesystem = connections.first { it.name == "Docs filesystem" }
        assertTrue(filesystem.isHealthy)
        assertEquals("Filesystem", filesystem.provider?.name)

        val http = api.getConnection("fc8f92a0-163b-40c6-b163-0106f299c754")
        assertEquals("unknown", http.status)
        assertEquals("custom-http", http.provider?.slug)
        val assignment = http.assignments!!.single()
        assertEquals(listOf("claude-code"), assignment.agentTypes)
        assertEquals("read", assignment.permission)
        // The row type has no `config` property: secret values never reach the model.
        assertTrue(ConnectionRow::class.java.declaredFields.none { it.name == "config" })

        assertEquals(assignment, api.listConnectionAssignments("x").single())
        val raw = server.lastRequest("GET", "/api/connections/fc8f92a0-163b-40c6-b163-0106f299c754")
        assertTrue(raw != null)
    }

    @Test
    fun connectionActions() = runTest {
        server.fixture("/api/connections/:id/test", "connection-test.json", method = "POST")
        server.fixture("/api/connections", "connection-filesystem.json", method = "POST", status = 201)
        server.fixture("/api/connections/:id", "connection-filesystem.json", method = "PATCH")
        server.on("DELETE", "/api/connections/:id") { FakeResponse.empty() }
        server.json("/api/connections/:id/assignments", """{"assignment":{"id":"a"}}""", method = "POST", status = 201)
        server.on("DELETE", "/api/connection-assignments/:id") { FakeResponse.empty() }

        val tested = api.testConnection("c")
        assertEquals("healthy", tested.status)
        assertEquals("Connection OK", tested.statusMessage)

        val created = api.createConnection(
            ConnectionCreateInput(
                providerId = "p",
                name = "My HTTP API",
                config = mapOf("baseUrl" to "https://x"),
                assignments = listOf(ConnectionAssignmentInput(repoId = null, agentTypes = emptyList(), permission = "read")),
            ),
        )
        assertEquals("Docs filesystem", created.name)
        val body = server.lastRequest("POST", "/api/connections")!!.json
        assertEquals("My HTTP API", body["name"]?.stringValue)
        assertEquals("""[{"agentTypes":[],"permission":"read"}]""", body["assignments"].toString())

        api.setConnectionEnabled("c", false)
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/connections/c")!!.body)
        api.deleteConnection("c")
        api.createConnectionAssignment("c", ConnectionAssignmentInput(repoId = "r", agentTypes = listOf("codex"), permission = "full"))
        assertEquals(
            """{"repoId":"r","agentTypes":["codex"],"permission":"full"}""",
            server.lastRequest("POST", "/api/connections/c/assignments")!!.body,
        )
        api.deleteConnectionAssignment("a")
        assertEquals(1, server.count("DELETE", "/api/connection-assignments/a"))
    }

    @Test
    fun errorsCarryTheServerMessage() = runTest {
        server.error("POST", "/api/repos", 409, "This repository has already been added")
        val error = assertFailsWith<ApiError> { api.createRepo(RepoCreateInput("u", "o/r")) }
        assertEquals(409, error.status)
        assertEquals("This repository has already been added", error.actionMessage())
    }
}
