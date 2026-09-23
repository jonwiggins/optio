package dev.optio.feature.library

import dev.optio.core.model.get
import dev.optio.core.model.intValue
import dev.optio.core.model.isNull
import dev.optio.core.model.stringValue
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.repos.NewRepoViewModel
import dev.optio.feature.library.repos.RepoDetail
import dev.optio.feature.library.repos.RepoDetailViewModel
import dev.optio.feature.library.repos.RepoSettingsViewModel
import dev.optio.feature.library.repos.ReposViewModel
import dev.optio.feature.library.repos.SharedDirectories
import dev.optio.feature.library.repos.SharedDirectoriesViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.JsonObject
import org.junit.Rule

/** Repos list, detail (MCP servers, recycle, remove), settings, shared directories, add repo. */
class RepoViewModelsTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    private val repoId = "85d784a6-338f-4675-9070-2890f6855cab"

    private fun serveRepo() {
        server.fixture("/api/repos/:id", "repo.json")
        server.fixture("/api/repos/:id/connections", "repo-connections.json")
        server.fixture("/api/repos/:id/mcp-servers", "repo-mcp-servers.json")
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories.json")
    }

    @Test
    fun reposListLoads() = runTest(main.dispatcher) {
        server.fixture("/api/repos", "repos.json")
        val vm = ReposViewModel(server.client())
        vm.onAppear()
        assertEquals(2, vm.awaitLoaded().size)
    }

    @Test
    fun detailLoadsTheRepoAndItsParts() = runTest(main.dispatcher) {
        serveRepo()
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.onAppear()
        val detail = vm.awaitLoaded()
        assertEquals("e2e-org/e2e-repo", detail.repo.displayName)
        assertEquals(1, detail.mcpServers.size)
        assertEquals(1, detail.directories.size)
        assertEquals(emptyList(), detail.connections)
    }

    @Test
    fun detailToleratesFailingParts() = runTest(main.dispatcher) {
        server.fixture("/api/repos/:id", "repo.json")
        server.error("GET", "/api/repos/:id/connections", 500, "boom")
        server.error("GET", "/api/repos/:id/mcp-servers", 403, "Forbidden")
        server.error("GET", "/api/repos/:id/shared-directories", 404, "Not found")
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.refresh()
        val detail = vm.awaitLoaded()
        assertEquals(RepoDetail(detail.repo), detail)
    }

    @Test
    fun detailFailsWhenTheRepoIsGone() = runTest(main.dispatcher) {
        server.error("GET", "/api/repos/:id", 404, "Repo not found")
        val vm = RepoDetailViewModel(server.client(), "gone")
        vm.refresh()
        assertEquals("Repo not found", vm.awaitFailure().message)
    }

    @Test
    fun recycleReportsHowManyPodsWent() = runTest(main.dispatcher) {
        serveRepo()
        server.fixture("/api/repos/:id/pods/recycle", "recycle.json", method = "POST")
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.refresh().join()
        vm.recycle()!!.join()
        assertFalse(vm.busy)
        assertEquals(ScreenEvent.Toast("Recycled 1 pod.", Tone.SUCCESS), vm.nextEvent())
    }

    @Test
    fun removeRepoClosesTheScreen() = runTest(main.dispatcher) {
        serveRepo()
        server.on("DELETE", "/api/repos/:id") { FakeResponse.empty() }
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.refresh().join()
        vm.delete()!!.join()
        assertEquals(ScreenEvent.Toast("Removed e2e-org/e2e-repo.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun repoMcpServersAddAndDelete() = runTest(main.dispatcher) {
        serveRepo()
        server.json("/api/repos/:id/mcp-servers", """{"server":{"id":"m2"}}""", method = "POST", status = 201)
        server.on("DELETE", "/api/mcp-servers/:id") { FakeResponse.empty() }
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.refresh().join()
        var closed = false
        vm.addMcpServer(McpServerDraft(name = "browser", command = "npx", args = "-y\n@playwright/mcp").input()) { closed = true }!!.join()
        assertTrue(closed)
        assertEquals(
            """{"name":"browser","command":"npx","args":["-y","@playwright/mcp"]}""",
            server.lastRequest("POST", "/api/repos/$repoId/mcp-servers")!!.body,
        )
        assertEquals(ScreenEvent.Toast("Added browser.", Tone.SUCCESS), vm.nextEvent())
        vm.deleteMcpServer(vm.state.value.value!!.mcpServers.single()).join()
        assertEquals(1, server.count("DELETE", "/api/mcp-servers/43ab3bda-9ca6-4f84-9c7a-77c156663ea2"))
    }

    @Test
    fun addingAnMcpServerAsAMemberKeepsTheSheetOpen() = runTest(main.dispatcher) {
        serveRepo()
        server.error("POST", "/api/repos/:id/mcp-servers", 403, "Forbidden")
        val vm = RepoDetailViewModel(server.client(), repoId)
        vm.refresh().join()
        var closed = false
        vm.addMcpServer(McpServerInput("a", "b")) { closed = true }!!.join()
        assertFalse(closed)
        assertFalse(vm.mcpSaving)
        assertEquals(ScreenEvent.Toast("You don't have permission to do that.", Tone.DANGER), vm.nextEvent())
    }

    @Test
    fun settingsPopulateFromTheRepoAndSaveOnePatch() = runTest(main.dispatcher) {
        server.fixture("/api/repos/:id", "repo.json")
        server.fixture("/api/repos/:id", "repo.json", method = "PATCH")
        val vm = RepoSettingsViewModel(server.client(), repoId)
        vm.loadOnce()
        vm.awaitLoaded()
        assertEquals(6, vm.form.maxConcurrentTasks)
        assertEquals("sonnet", vm.form.reviewModel)
        assertEquals(250, vm.form.maxTurnsCoding, "an unset column takes iOS's default")

        vm.update { it.copy(maxPodInstances = 3, reviewEnabled = true, setupCommands = "pnpm i") }
        vm.update { it.withCautiousMode(true) }
        vm.save()!!.join()
        val patch = server.lastRequest("PATCH", "/api/repos/$repoId")!!.json as JsonObject
        assertEquals(3, patch["maxPodInstances"]?.intValue)
        assertEquals("pnpm i", patch["setupCommands"]?.stringValue)
        assertEquals("false", patch["autoMerge"].toString())
        assertTrue(patch["reviewAgentType"]!!.isNull)
        assertEquals("sonnet", patch["reviewModel"]?.stringValue)
        assertEquals(29, patch.size)
        assertEquals(ScreenEvent.Toast("Settings saved.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun settingsSaveErrorShowsTheServerMessage() = runTest(main.dispatcher) {
        server.fixture("/api/repos/:id", "repo.json")
        server.error("PATCH", "/api/repos/:id", 400, "Review model \"sonnet\" does not belong to the \"gemini\" catalog.")
        val vm = RepoSettingsViewModel(server.client(), repoId)
        vm.refresh().join()
        vm.update { it.copy(reviewAgentType = "gemini") }
        vm.save()!!.join()
        assertEquals(ScreenEvent.Toast("Review model \"sonnet\" does not belong to the \"gemini\" catalog.", Tone.DANGER), vm.nextEvent())
    }

    @Test
    fun sharedDirectoriesReadThePodCountAndRunActions() = runTest(main.dispatcher) {
        server.json("/api/repos/:id", """{"repo":{"id":"r","maxPodInstances":3}}""")
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories.json")
        server.json("/api/repos/:id/shared-directories/:dir/usage", """{"usage":null}""", method = "POST")
        server.json("/api/repos/:id/shared-directories/:dir/clear", """{"ok":true}""", method = "POST")
        server.fixture("/api/repos/:id/pods/recycle", "recycle.json", method = "POST")
        val vm = SharedDirectoriesViewModel(server.client(), "r")
        vm.onAppear()
        val data = vm.awaitLoaded()
        assertEquals(3, data.maxPodInstances)
        val dir = data.directories.single()

        vm.checkUsage(dir)!!.join()
        assertEquals("unavailable", vm.usage[dir.id])
        assertNull(vm.busyId)

        vm.clear(dir)!!.join()
        assertEquals(ScreenEvent.Toast("Cleared npm-cache.", Tone.SUCCESS), vm.nextEvent())

        vm.recycle()!!.join()
        assertEquals(ScreenEvent.Toast("Recycled 1 pod.", Tone.SUCCESS), vm.nextEvent())
    }

    @Test
    fun sharedDirectoriesFallBackToOnePodWhenTheRepoFails() = runTest(main.dispatcher) {
        server.error("GET", "/api/repos/:id", 500, "boom")
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories-empty.json")
        val vm = SharedDirectoriesViewModel(server.client(), "r")
        vm.refresh()
        assertEquals(SharedDirectories(emptyList(), 1), vm.awaitLoaded())
    }

    @Test
    fun sharedDirectoryAddAndDelete() = runTest(main.dispatcher) {
        server.json("/api/repos/:id", """{"repo":{"id":"r"}}""")
        server.fixture("/api/repos/:id/shared-directories", "repo-shared-directories.json")
        server.fixture("/api/repos/:id/shared-directories", "shared-directory-created.json", method = "POST", status = 201)
        server.on("DELETE", "/api/repos/:id/shared-directories/:dir") { FakeResponse.empty() }
        val vm = SharedDirectoriesViewModel(server.client(), "r")
        vm.refresh().join()
        var closed = false
        vm.add(SharedDirectoryInput("pip-cache", "pip cache", "home", ".cache/pip", 5)) { closed = true }!!.join()
        assertTrue(closed)
        assertEquals(
            """{"name":"pip-cache","description":"pip cache","mountLocation":"home","mountSubPath":".cache/pip","sizeGi":5}""",
            server.lastRequest("POST", "/api/repos/r/shared-directories")!!.body,
        )
        assertEquals(ScreenEvent.Toast("Added pip-cache.", Tone.SUCCESS), vm.nextEvent())
        vm.delete(vm.state.value.value!!.directories.single())!!.join()
        assertEquals(1, server.count("DELETE", "/api/repos/r/shared-directories/97c149c7-a774-4396-aa2e-f2c4f410b9e8"))
    }

    @Test
    fun newRepoValidationFailureInfersTheName() = runTest(main.dispatcher) {
        server.fixture("/api/setup/validate/repo", "validate-repo.json", method = "POST")
        val vm = NewRepoViewModel(server.client())
        assertFalse(vm.canValidate)
        vm.onRepoUrlChange("https://github.com/e2e-org/not-a-real-repo.git")
        vm.validate()!!.join()
        assertEquals("Repository not accessible (401)", vm.validationError)
        assertFalse(vm.validated)
        assertEquals("e2e-org/not-a-real-repo", vm.fullName)
        assertTrue(vm.canCreate)
        // Editing the URL clears the result.
        vm.onRepoUrlChange("https://github.com/x/y")
        assertNull(vm.validationError)
    }

    @Test
    fun newRepoValidationSuccessFillsTheDetails() = runTest(main.dispatcher) {
        server.json(
            "/api/setup/validate/repo",
            """{"valid":true,"repo":{"fullName":"acme/api","defaultBranch":"trunk","isPrivate":true}}""",
            method = "POST",
        )
        val vm = NewRepoViewModel(server.client())
        vm.onRepoUrlChange("https://github.com/acme/api")
        vm.validate()!!.join()
        assertTrue(vm.validated)
        assertEquals("acme/api", vm.fullName)
        assertEquals("trunk", vm.defaultBranch)
        assertTrue(vm.isPrivate)
    }

    @Test
    fun newRepoTransportFailureIsAValidationError() = runTest(main.dispatcher) {
        server.error("POST", "/api/setup/validate/repo", 403, "Forbidden")
        val vm = NewRepoViewModel(server.client())
        vm.onRepoUrlChange("https://github.com/acme/api")
        vm.validate()!!.join()
        assertEquals("You don't have permission to do that.", vm.validationError)
        assertEquals("acme/api", vm.fullName)
    }

    @Test
    fun newRepoCreatesThenPatchesTheOptions() = runTest(main.dispatcher) {
        server.json("/api/repos", """{"repo":{"id":"new","fullName":"acme/api"}}""", method = "POST", status = 201)
        server.error("PATCH", "/api/repos/:id", 500, "ignored")
        val vm = NewRepoViewModel(server.client())
        vm.onRepoUrlChange(" https://github.com/acme/api ")
        vm.fullName = "acme/api"
        vm.imagePreset = "python"
        vm.maxConcurrentTasks = 4
        vm.reviewEnabled = true
        vm.reviewTrigger = "on_pr"
        vm.create()!!.join()
        assertEquals(
            """{"repoUrl":"https://github.com/acme/api","fullName":"acme/api","defaultBranch":"main","isPrivate":false}""",
            server.lastRequest("POST", "/api/repos")!!.body,
        )
        assertEquals(
            """{"imagePreset":"python","maxConcurrentTasks":4,"reviewEnabled":true,"reviewTrigger":"on_pr","autoResume":false,"autoMerge":false}""",
            server.lastRequest("PATCH", "/api/repos/new")!!.body,
        )
        // iOS ignores a failed options PATCH: the repo exists.
        assertEquals(ScreenEvent.Toast("Added acme/api.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun newRepoConflictStaysOpen() = runTest(main.dispatcher) {
        server.error("POST", "/api/repos", 409, "This repository has already been added")
        val vm = NewRepoViewModel(server.client())
        vm.onRepoUrlChange("https://github.com/acme/api")
        vm.fullName = "acme/api"
        vm.create()!!.join()
        assertEquals(ScreenEvent.Toast("This repository has already been added", Tone.DANGER), vm.nextEvent())
        assertFalse(vm.creating)
        assertEquals(0, server.count("PATCH", "/api/repos/:id"))
    }
}
