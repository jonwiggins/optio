package dev.optio.feature.library

import dev.optio.core.model.get
import dev.optio.core.model.isNull
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiError
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.library.prompts.PromptDetailViewModel
import dev.optio.feature.library.prompts.PromptEditorViewModel
import dev.optio.feature.library.prompts.PromptsViewModel
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.toList
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.runTest
import org.junit.Rule

/** Prompts list, detail (preview, delete) and editor (create, edit) against a fake API. */
class PromptViewModelsTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    @Test
    fun listLoadsFiltersAndReloadsQuietlyOnReturn() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        val vm = PromptsViewModel(server.client())
        val seen = mutableListOf<LoadState<List<PromptTemplateRow>>>()
        backgroundScope.launch { vm.state.toList(seen) }
        vm.onAppear()
        assertEquals(4, vm.awaitLoaded().size)

        vm.setFilter("review")
        assertEquals("review", vm.filter.value)

        // Back from a pushed screen: the list reloads without a spinner (no Loading with a value).
        server.json("/api/prompt-templates", """{"templates":[{"id":"only","name":"Only","kind":"job"}]}""")
        vm.onAppear()
        assertEquals("Only", vm.awaitLoaded { it.size == 1 }.single().name)
        assertTrue(seen.none { it is LoadState.Loading && it.previous != null }, "quiet reload must not show a spinner: $seen")
        assertEquals(2, server.count("GET", "/api/prompt-templates"))
    }

    @Test
    fun listFailureKeepsTheErrorForTheErrorRow() = runTest(main.dispatcher) {
        server.error("GET", "/api/prompt-templates", 500, "boom")
        val vm = PromptsViewModel(server.client())
        vm.refresh()
        assertEquals(500, (vm.awaitFailure() as ApiError).status)
    }

    @Test
    fun deleteCallsTheApiToastsAndReloads() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        server.on("DELETE", "/api/prompt-templates/:id") { FakeResponse.empty() }
        val vm = PromptsViewModel(server.client())
        vm.refresh().join()
        val victim = vm.state.value.value!!.first()
        vm.delete(victim).join()
        assertEquals(1, server.count("DELETE", "/api/prompt-templates/${victim.id}"))
        assertEquals(ScreenEvent.Toast("Deleted “Explain a failing test”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(2, server.count("GET", "/api/prompt-templates"))
    }

    @Test
    fun aViewerDeleteBecomesAPermissionToast() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        server.error("DELETE", "/api/prompt-templates/:id", 403, "Insufficient role")
        val vm = PromptsViewModel(server.client())
        vm.refresh().join()
        vm.delete(vm.state.value.value!!.first()).join()
        val toast = vm.nextToast()
        assertEquals(Tone.DANGER, toast.tone)
        assertEquals("You don't have permission to do that. Insufficient role", toast.message)
    }

    @Test
    fun detailFindsItsTemplateOrFails404() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        val vm = PromptDetailViewModel(server.client(), "e05074fb-50b7-4739-9a33-97351b21603c")
        vm.onAppear()
        val template = vm.awaitLoaded()
        assertEquals("Add a feature flag", template.name)
        assertEquals(listOf("flag", "owner"), template.paramNames)

        val missing = PromptDetailViewModel(server.client(), "gone")
        missing.refresh()
        assertEquals(ApiError.NOT_FOUND, (missing.awaitFailure() as ApiError).status)
    }

    @Test
    fun previewSendsTypedValuesThenExtraLines() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        server.fixture("/api/prompt-templates/:id/preview", "prompt-preview.json", method = "POST")
        val id = "e05074fb-50b7-4739-9a33-97351b21603c"
        val vm = PromptDetailViewModel(server.client(), id)
        vm.refresh().join()
        vm.params["flag"] = "dark-mode"
        vm.params["owner"] = ""
        vm.extraParams = "owner = ada\nnonsense\n"
        assertEquals(mapOf("flag" to "dark-mode", "owner" to "ada"), vm.previewParams())
        vm.preview()!!.join()
        assertFalse(vm.rendering)
        assertEquals("Add a feature flag named dark-mode owned by ada, default off, and open a PR.", vm.rendered)
        val body = server.lastRequest("POST", "/api/prompt-templates/$id/preview")!!.json
        assertEquals("dark-mode", body["params"]?.get("flag")?.stringValue)
        assertEquals("ada", body["params"]?.get("owner")?.stringValue)
    }

    @Test
    fun detailDeleteClosesTheScreen() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        server.on("DELETE", "/api/prompt-templates/:id") { FakeResponse.empty() }
        val vm = PromptDetailViewModel(server.client(), "2ae8cd69-5ee1-455d-b5c1-3251a234517d")
        vm.refresh().join()
        vm.delete()!!.join()
        assertEquals(ScreenEvent.Toast("Deleted “Strict code review”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun editorCreatesWithoutEmptyOptionals() = runTest(main.dispatcher) {
        server.json("/api/prompt-templates/named", """{"template":{"id":"n1","name":"Triage"}}""", method = "POST", status = 201)
        val vm = PromptEditorViewModel(server.client(), id = null)
        vm.loadOnce()
        assertEquals(Unit, vm.awaitLoaded())
        assertTrue(vm.isNew)
        assertFalse(vm.canSave)
        vm.name = "  Triage  "
        assertFalse(vm.canSave, "a body is required")
        vm.body = "Look at {{issue}}"
        vm.kind = PromptKind.JOB
        assertTrue(vm.canSave)
        vm.save()!!.join()
        assertEquals(
            """{"name":"Triage","template":"Look at {{issue}}","kind":"job"}""",
            server.lastRequest("POST", "/api/prompt-templates/named")!!.body,
        )
        assertEquals(ScreenEvent.Toast("Created “Triage”.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun editorPopulatesOnceAndPatchesWithExplicitNulls() = runTest(main.dispatcher) {
        server.fixture("/api/prompt-templates", "prompt-templates.json")
        val id = "e05074fb-50b7-4739-9a33-97351b21603c"
        server.json("/api/prompt-templates/$id", """{"template":{"id":"$id","name":"Flag"}}""", method = "PATCH")
        val vm = PromptEditorViewModel(server.client(), id)
        vm.loadOnce()
        vm.awaitLoaded()
        assertEquals("Add a feature flag", vm.name)
        assertEquals(PromptKind.TASK, vm.kind)
        assertEquals("Repo task: wire a new flag end to end", vm.description)

        vm.name = "Flag"
        vm.description = ""
        vm.defaultAgentType = ""
        // A second appearance must not overwrite the edits.
        vm.loadOnce()
        vm.refresh().join()
        assertEquals("Flag", vm.name)

        vm.save()!!.join()
        val patch = server.lastRequest("PATCH", "/api/prompt-templates/$id")!!.json
        assertEquals("Flag", patch["name"]?.stringValue)
        assertEquals("task", patch["kind"]?.stringValue)
        assertTrue(patch["description"]!!.isNull)
        assertTrue(patch["defaultAgentType"]!!.isNull)
        assertEquals(ScreenEvent.Toast("Saved.", Tone.SUCCESS), vm.nextEvent())
        assertEquals(ScreenEvent.Close, vm.nextEvent())
    }

    @Test
    fun editorFailureToastsAndStaysOpen() = runTest(main.dispatcher) {
        server.error("POST", "/api/prompt-templates/named", 400, "Bad Request")
        val vm = PromptEditorViewModel(server.client(), id = null)
        vm.name = "x"
        vm.body = "y"
        vm.save()!!.join()
        assertEquals(ScreenEvent.Toast("Bad Request", Tone.DANGER), vm.nextEvent())
        assertFalse(vm.saving)
        assertNull(vm.state.value.errorOrNull)
    }
}
