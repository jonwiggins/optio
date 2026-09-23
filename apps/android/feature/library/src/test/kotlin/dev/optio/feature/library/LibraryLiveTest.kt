package dev.optio.feature.library

import dev.optio.core.model.OptioJson
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.connections.AccessControl
import dev.optio.feature.library.connections.ConnectionDetailViewModel
import dev.optio.feature.library.connections.ConnectionsViewModel
import dev.optio.feature.library.connections.NewConnectionViewModel
import dev.optio.feature.library.prompts.PromptDetailViewModel
import dev.optio.feature.library.prompts.PromptEditorViewModel
import dev.optio.feature.library.prompts.PromptsViewModel
import dev.optio.feature.library.repos.NewRepoViewModel
import dev.optio.feature.library.repos.RepoDetailViewModel
import dev.optio.feature.library.repos.RepoSettingsViewModel
import dev.optio.feature.library.repos.SharedDirectoriesViewModel
import java.io.File
import java.util.UUID
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Assume.assumeTrue
import org.junit.Rule

/**
 * The Library against a running DevLab test API (PLAN §8), through the same ViewModels the screens
 * use. Skipped unless the environment names an API; start one with `test-api.sh start --port N`:
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4968 ./gradlew :feature:library:testDebugUnitTest --tests '*LibraryLiveTest' --rerun
 * ```
 *
 * `OPTIO_TEST_API_TOKEN` (default `dev`) is the PAT; against an auth-enabled instance pass its
 * `auth.adminToken`. Role gating needs an auth-enabled instance: `OPTIO_TEST_AUTH_SEED` is the path
 * of its `seed.json` (admin, member and viewer PATs). Everything a test creates it deletes again.
 */
class LibraryLiveTest {
    @get:Rule
    val main = MainDispatcherRule()

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")
    private val token: String = System.getenv("OPTIO_TEST_API_TOKEN") ?: "dev"
    private val suffix = UUID.randomUUID().toString().take(8)

    private fun api(): ApiClient {
        assumeTrue("OPTIO_TEST_API_URL is not set", baseUrl != null)
        return ApiClient(baseUrl, token)
    }

    @Test
    fun promptCreatePreviewEditDelete() = runTest(main.dispatcher) {
        val api = api()
        val name = "Android live $suffix"

        val editor = PromptEditorViewModel(api, id = null)
        editor.name = name
        editor.kind = PromptKind.JOB
        editor.description = "Made by LibraryLiveTest"
        editor.defaultAgentType = "codex"
        editor.body = "Say {{thing}}{{#if loud}} loudly{{/if}}."
        editor.save()!!.join()
        assertEquals(ScreenEvent.Toast("Created “$name”.", Tone.SUCCESS), editor.nextEvent())
        assertEquals(ScreenEvent.Close, editor.nextEvent())

        val list = PromptsViewModel(api)
        list.refresh().join()
        val created = list.state.value.value!!.single { it.name == name }
        assertEquals("job", created.kind)
        assertEquals("codex", created.defaultAgentType)
        assertEquals(listOf("loud", "thing"), created.paramNames)

        val detail = PromptDetailViewModel(api, created.id)
        detail.refresh().join()
        detail.params["thing"] = "hi"
        detail.extraParams = "loud=yes"
        detail.preview()!!.join()
        assertEquals("Say hi loudly.", detail.rendered)

        val edit = PromptEditorViewModel(api, created.id)
        edit.loadOnce()
        edit.awaitLoaded()
        assertEquals(name, edit.name)
        edit.name = "$name (edited)"
        edit.description = ""
        edit.defaultAgentType = ""
        edit.save()!!.join()
        assertEquals(ScreenEvent.Toast("Saved.", Tone.SUCCESS), edit.nextEvent())
        val edited = api.listPromptTemplates().single { it.id == created.id }
        assertEquals("$name (edited)", edited.name)
        assertNull(edited.description, "a cleared description is cleared on the server")
        assertNull(edited.defaultAgentType)

        detail.delete()!!.join()
        assertTrue(api.listPromptTemplates().none { it.id == created.id })
    }

    @Test
    fun addARepoConfigureItAndRemoveIt() = runTest(main.dispatcher) {
        val api = api()
        val url = "https://github.com/android-a7/live-$suffix"

        val add = NewRepoViewModel(api)
        add.onRepoUrlChange(url)
        add.validate()!!.join()
        // The DevLab API has no real GitHub token: validation fails, the form stays usable.
        assertFalse(add.validated)
        assertNotNull(add.validationError)
        assertEquals("android-a7/live-$suffix", add.fullName)
        add.imagePreset = "python"
        add.maxConcurrentTasks = 3
        add.reviewEnabled = true
        add.reviewTrigger = "on_pr"
        add.create()!!.join()
        assertEquals(ScreenEvent.Toast("Added android-a7/live-$suffix.", Tone.SUCCESS), add.nextEvent())
        val repo = api.listRepos().single { it.repoUrl == url }
        try {
            assertEquals("python", repo.imagePreset)
            assertEquals(3, repo.maxConcurrentTasks)
            assertEquals(true, repo.reviewEnabled)
            assertEquals("on_pr", repo.reviewTrigger)

            val settings = RepoSettingsViewModel(api, repo.id)
            settings.loadOnce()
            settings.awaitLoaded()
            settings.update { it.copy(maxPodInstances = 2, setupCommands = "echo ready", extraPackages = "jq", testCommand = "make test") }
            settings.save()!!.join()
            assertEquals(ScreenEvent.Toast("Settings saved.", Tone.SUCCESS), settings.nextEvent())
            var saved = api.getRepo(repo.id)
            assertEquals(2, saved.maxPodInstances)
            assertEquals("echo ready", saved.setupCommands)
            assertEquals("make test", saved.testCommand)
            assertNull(saved.reviewAgentType)

            // Clearing extra packages sticks (sent as "").
            val again = RepoSettingsViewModel(api, repo.id)
            again.loadOnce()
            again.awaitLoaded()
            assertEquals("jq", again.form.extraPackages)
            again.update { it.copy(extraPackages = "") }
            again.save()!!.join()
            saved = api.getRepo(repo.id)
            assertTrue(saved.extraPackages.isNullOrEmpty())

            val detail = RepoDetailViewModel(api, repo.id)
            detail.onAppear()
            assertEquals(repo.id, detail.awaitLoaded().repo.id)
            detail.addMcpServer(McpServerDraft(name = "live-$suffix", command = "npx", args = "-y\n@modelcontextprotocol/server-memory").input()) {}!!.join()
            assertEquals(ScreenEvent.Toast("Added live-$suffix.", Tone.SUCCESS), detail.nextEvent())
            val withMcp = detail.awaitLoaded { d -> d.mcpServers.any { it.name == "live-$suffix" } }
            val repoMcp = withMcp.mcpServers.single { it.name == "live-$suffix" }
            assertFalse(repoMcp.isGlobal)
            detail.deleteMcpServer(repoMcp).join()
            assertTrue(api.listRepoMcpServers(repo.id).none { it.id == repoMcp.id })
            detail.recycle()!!.join()
            val recycled = detail.nextToast()
            assertTrue(recycled.message.contains("recycle", ignoreCase = true), recycled.message)

            val dirs = SharedDirectoriesViewModel(api, repo.id)
            dirs.onAppear()
            assertEquals(2, dirs.awaitLoaded().maxPodInstances)
            dirs.add(dev.optio.feature.library.repos.SharedDirectoryDraft().withPreset("uv").input()) {}!!.join()
            val dir = dirs.awaitLoaded { it.directories.isNotEmpty() }.directories.single()
            assertEquals("uv-cache", dir.name)
            dirs.checkUsage(dir)!!.join()
            assertNotNull(dirs.usage[dir.id])
            dirs.delete(dir)!!.join()
            assertTrue(api.listSharedDirectories(repo.id).isEmpty())

            detail.delete()!!.join()
            assertTrue(api.listRepos().none { it.id == repo.id })
        } finally {
            runCatching { api.deleteRepo(repo.id) }
        }
    }

    @Test
    fun addTestToggleAndDeleteAConnection() = runTest(main.dispatcher) {
        val api = api()
        val provider = api.listConnectionProviders().single { it.slug == "custom-http" }
        val repos = api.listRepos()

        val add = NewConnectionViewModel(api, provider.id)
        add.loadOnce()
        add.awaitLoaded()
        assertEquals("My HTTP API", add.name)
        add.name = "Live HTTP $suffix"
        add.config["baseUrl"] = "https://status.example.com/$suffix"
        add.config["authType"] = "none"
        add.access = AccessControl(repoId = repos.first().id).toggling("claude-code", true)
        add.save()!!.join()
        assertEquals(ScreenEvent.Toast("Added “Live HTTP $suffix”.", Tone.SUCCESS), add.nextEvent())

        val hub = ConnectionsViewModel(api)
        hub.onAppear()
        val connection = hub.awaitLoaded().connections.single { it.name == "Live HTTP $suffix" }
        try {
            val detail = ConnectionDetailViewModel(api, connection.id)
            detail.onAppear()
            val loaded = detail.awaitLoaded()
            assertEquals("unknown", loaded.connection.status)
            val assignment = loaded.assignments.single()
            assertEquals(repos.first().id, assignment.repoId)
            assertEquals(listOf("claude-code"), assignment.agentTypes)

            detail.test()!!.join()
            assertEquals(ScreenEvent.Toast("Healthy: Connection OK", Tone.SUCCESS), detail.nextEvent())
            assertEquals("healthy", detail.awaitLoaded { it.connection.status == "healthy" }.connection.status)

            detail.setEnabled(false)!!.join()
            assertEquals(false, detail.awaitLoaded { it.connection.enabled == false }.connection.enabled)
            detail.setEnabled(true)!!.join()

            detail.addAssignment(AccessControl(permission = "full")) {}!!.join()
            val two = detail.awaitLoaded { it.assignments.size == 2 }
            val global = two.assignments.single { it.repoId == null }
            assertEquals("full", global.permission)
            detail.deleteAssignment(global).join()
            assertEquals(1, detail.awaitLoaded { it.assignments.size == 1 }.assignments.size)

            detail.delete()!!.join()
            assertTrue(api.listConnections().none { it.id == connection.id })
        } finally {
            runCatching { api.deleteConnection(connection.id) }
        }
    }

    @Test
    fun globalMcpServerToggle() = runTest(main.dispatcher) {
        val api = api()
        val hub = ConnectionsViewModel(api)
        hub.addMcpServer(McpServerInput(name = "live-global-$suffix", command = "npx", args = listOf("-y", "@modelcontextprotocol/server-memory"))) {}!!.join()
        val server = api.listMcpServers(scope = "global").single { it.name == "live-global-$suffix" }
        try {
            hub.refresh().join()
            hub.setMcpEnabled(server, false)!!.join()
            assertEquals(false, api.listMcpServers(scope = "global").single { it.id == server.id }.enabled)
            hub.deleteMcpServer(server).join()
            assertTrue(api.listMcpServers(scope = "global").none { it.id == server.id })
        } finally {
            runCatching { api.deleteMcpServer(server.id) }
        }
    }

    /** Role gating on an auth-enabled instance: what each role may do, and the 403 copy the others see. */
    @Test
    fun rolesAreEnforcedAndExplained() = runTest(main.dispatcher) {
        val seedPath = System.getenv("OPTIO_TEST_AUTH_SEED")
        assumeTrue("OPTIO_TEST_AUTH_SEED is not set", seedPath != null)
        val seed = OptioJson.parseToJsonElement(File(seedPath!!).readText())
        val url = seed["api"]?.get("baseUrl")?.stringValue!!
        val admin = ApiClient(url, seed["auth"]?.get("adminToken")?.stringValue)
        val member = ApiClient(url, seed["auth"]?.get("memberToken")?.stringValue)
        val viewer = ApiClient(url, seed["auth"]?.get("viewerToken")?.stringValue)

        assertTrue(admin.currentUser().isAdmin)
        assertTrue(member.currentUser().canMutate)
        assertFalse(member.currentUser().isAdmin)
        assertFalse(viewer.currentUser().canMutate)

        // Everyone reads.
        assertEquals(4, viewer.listPromptTemplates().size)
        assertTrue(viewer.listRepos().isNotEmpty())
        assertTrue(viewer.listConnections().isNotEmpty())

        // A viewer can't write a prompt; the editor explains.
        val viewerEditor = PromptEditorViewModel(viewer, id = null).apply {
            name = "Viewer $suffix"
            body = "x"
        }
        viewerEditor.save()!!.join()
        val denied = viewerEditor.nextToast()
        assertEquals(Tone.DANGER, denied.tone)
        assertTrue(denied.message.startsWith("You don't have permission to do that."), denied.message)

        // A member writes prompts but not repos, connections, MCP servers or shared directories.
        val memberEditor = PromptEditorViewModel(member, id = null).apply {
            name = "Member $suffix"
            body = "Hello {{who}}"
        }
        memberEditor.save()!!.join()
        assertEquals(ScreenEvent.Toast("Created “Member $suffix”.", Tone.SUCCESS), memberEditor.nextEvent())
        val memberPrompt = member.listPromptTemplates().single { it.name == "Member $suffix" }
        member.deletePromptTemplate(memberPrompt.id)

        val repo = admin.listRepos().first()
        val memberRepo = NewRepoViewModel(member).apply {
            onRepoUrlChange("https://github.com/android-a7/member-$suffix")
            fullName = "android-a7/member-$suffix"
        }
        memberRepo.create()!!.join()
        assertTrue(memberRepo.nextToast().message.startsWith("You don't have permission to do that."))
        assertIs<ApiError>(runCatching { member.createRepoMcpServer(repo.id, McpServerInput("x", "y")) }.exceptionOrNull())
        assertEquals(403, (runCatching { member.createSharedDirectory(repo.id, SharedDirectoryInput("x", null, "home", ".x", 1)) }.exceptionOrNull() as ApiError).status)
        val connection = admin.listConnections().first()
        val memberDetail = ConnectionDetailViewModel(member, connection.id)
        memberDetail.refresh().join()
        memberDetail.test()!!.join()
        assertTrue(memberDetail.nextToast().message.startsWith("You don't have permission to do that."))
        // Members may manage assignments (the server's `requireRole("member")`).
        member.createConnectionAssignment(connection.id, ConnectionAssignmentInput(repoId = null, agentTypes = listOf("cursor"), permission = "read"))
        val added = admin.listConnectionAssignments(connection.id).single { it.agentTypes == listOf("cursor") }
        member.deleteConnectionAssignment(added.id)

        // An admin tests the connection.
        val adminDetail = ConnectionDetailViewModel(admin, connection.id)
        adminDetail.refresh().join()
        adminDetail.test()!!.join()
        assertEquals(Tone.SUCCESS, adminDetail.nextToast().tone)
    }
}
