package dev.optio.feature.tasks.scheduled

import androidx.lifecycle.ViewModelStore
import dev.optio.core.model.stringValue
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.tasks.RealMainRule
import dev.optio.feature.tasks.await
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.TaskConfigRow
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.eventually
import dev.optio.feature.tasks.make
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlinx.coroutines.flow.first
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/** The scheduled blueprint page and form against a fake API serving captured fixtures. */
class ScheduledViewModelsTest {
    @get:Rule val fake = FakeOptioServerRule()

    @get:Rule val main = RealMainRule()

    private val server: FakeOptioServer get() = fake.server
    private val store = ViewModelStore()

    @AfterTest
    fun tearDown() = main.onMain { store.clear() }

    private fun serveBlueprint() {
        server.fixture("/api/task-configs/:id", "scheduled.json")
        server.fixture("/api/task-configs/:id/triggers", "scheduled-triggers.json")
        server.fixture("/api/tasks/:id/runs", "scheduled-runs.json")
    }

    @Test
    fun loadsConfigTriggersAndRuns() = main.onMain {
        serveBlueprint()
        val api = server.client()
        val vm = store.make { ScheduledDetailViewModel(api, "s1") }
        vm.load()
        val detail = vm.state.await { it is LoadState.Loaded }.value!!
        assertEquals("Weekly dependency bump", detail.config.name)
        assertEquals("0 9 * * 1", detail.triggers.single().cronExpression)
        assertEquals("pr_opened", detail.runs.single().state)
        assertEquals("Every Monday 09:00", ScheduledHeaderText.secondary(detail.triggers))
        assertEquals("e2e-org/e2e-repo · main · Claude Code · 1 trigger", ScheduledHeaderText.line(detail.config, detail.triggers)?.text)
        assertEquals("e2e-org/e2e-repo · main · Claude Code · manual only", ScheduledHeaderText.line(detail.config, emptyList())?.text)
    }

    @Test
    fun theBlueprintIsRequiredTriggersAndRunsAreNot() = main.onMain {
        serveBlueprint()
        server.error("GET", "/api/tasks/:id/runs", 500, "boom")
        server.error("GET", "/api/task-configs/:id/triggers", 500, "boom")
        val api = server.client()
        val vm = store.make { ScheduledDetailViewModel(api, "s1") }
        vm.load()
        val detail = vm.state.await { it is LoadState.Loaded }.value!!
        assertTrue(detail.runs.isEmpty() && detail.triggers.isEmpty())

        server.error("GET", "/api/task-configs/:id", 404, "Task config not found")
        val failing = store.make { ScheduledDetailViewModel(api, "s1") }
        failing.load()
        assertIs<LoadState.Failed<*>>(failing.state.await { it is LoadState.Failed })
    }

    @Test
    fun runNowPauseTriggersAndDelete() = main.onMain {
        serveBlueprint()
        server.json("/api/task-configs/:id/run", """{"taskId":"3b8bf012-e232-428e-b31f-f43a797bc2b0"}""", method = "POST", status = 202)
        server.fixture("/api/task-configs/:id", "scheduled.json", method = "PATCH")
        server.json("/api/task-configs/:id/triggers/:triggerId", """{"trigger":{"id":"x","type":"schedule","enabled":false}}""", method = "PATCH")
        server.on("DELETE", "/api/task-configs/:id/triggers/:triggerId") { FakeResponse.empty() }
        server.json("/api/task-configs/:id/triggers", """{"trigger":{"id":"n","type":"ticket","enabled":true}}""", method = "POST", status = 201)
        server.on("DELETE", "/api/task-configs/:id") { FakeResponse.empty() }
        val api = server.client()
        val vm = store.make { ScheduledDetailViewModel(api, "s1") }
        vm.load()
        val detail = vm.state.await { it is LoadState.Loaded }.value!!

        vm.runNow()
        assertEquals(UiMessage.Success("Task queued: 3b8bf012"), vm.messages.first())

        vm.busy.await { !it }
        vm.toggleEnabled()
        assertEquals(UiMessage.Success("Paused"), vm.messages.first())
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/task-configs/s1")!!.body)

        vm.busy.await { !it }
        val trigger = detail.triggers.single()
        vm.setTriggerEnabled(trigger, false)
        eventually { server.lastRequest("PATCH", "/api/task-configs/s1/triggers/${trigger.id}") != null }
        vm.busy.await { !it }

        vm.addTrigger(TriggerDraft.new(TriggerKind.TICKET).withStrings("labels", listOf("deps")))
        val body = server.lastRequest("POST", "/api/task-configs/s1/triggers")!!.json.jsonObject
        assertEquals("ticket", body["type"]?.stringValue)
        assertEquals(JsonObject(mapOf("source" to JsonPrimitive("github"), "labels" to kotlinx.serialization.json.JsonArray(listOf(JsonPrimitive("deps"))))), body["config"])
        assertEquals(UiMessage.Success("Trigger added"), vm.messages.first())

        vm.deleteTrigger(trigger)
        assertEquals(UiMessage.Success("Trigger deleted"), vm.messages.first())

        vm.busy.await { !it }
        vm.delete()
        assertEquals(UiMessage.Success("Deleted"), vm.messages.first())
        assertEquals(UiMessage.Close, vm.messages.first())
        assertNotNull(server.lastRequest("DELETE", "/api/task-configs/s1"))
    }

    @Test
    fun editFormLoadsAndPatchesWithExplicitNulls() = main.onMain {
        serveBlueprint()
        server.fixture("/api/repos", "repos.json")
        server.fixture("/api/prompt-templates", "prompt-templates-task.json")
        server.fixture("/api/task-configs/:id", "scheduled.json", method = "PATCH")
        val api = server.client()
        val vm = store.make { ScheduledFormViewModel(api, "s1") }
        vm.load()
        vm.loading.await { it is LoadState.Loaded }
        vm.templates.await { it.isNotEmpty() }
        assertEquals("Weekly dependency bump", vm.draft.value.name)
        assertEquals(2, vm.repos.value.size)

        // Picking a template fills the prompt; an edit keeps its branch when the repo changes.
        val template = vm.templates.value.single()
        vm.selectTemplate(template.id)
        assertEquals(template.template, vm.draft.value.prompt)
        vm.selectRepo("https://github.com/e2e-org/mobile-app")
        assertEquals("main", vm.draft.value.branch)
        vm.update { it.copy(agentType = "", description = "") }

        var saved: TaskConfigRow? = null
        vm.save { saved = it }
        eventually { saved != null }
        // The blueprint's own id (the fixture's), whatever the route was opened with.
        val body = server.lastRequest("PATCH", "/api/task-configs/${saved!!.id}")!!.json.jsonObject
        assertEquals(JsonNull, body["agentType"], "Repo default clears the agent")
        assertEquals(JsonNull, body["description"])
        assertEquals(template.id, body["promptTemplateId"]?.stringValue)
        assertEquals("https://github.com/e2e-org/mobile-app", body["repoUrl"]?.stringValue)
    }

    @Test
    fun createFormPicksTheFirstRepoAndOmitsUnsetFields() = main.onMain {
        server.fixture("/api/repos", "repos.json")
        server.json("/api/prompt-templates", """{"templates":[]}""")
        server.json("/api/task-configs", Fixtures.text("scheduled.json"), method = "POST", status = 201)
        val api = server.client()
        val vm = store.make { ScheduledFormViewModel(api, null) }
        vm.load()
        vm.loading.await { it is LoadState.Loaded }
        vm.draft.await { it.repoUrl.isNotEmpty() }
        val first = vm.repos.value.first()
        assertEquals(first.repoUrl, vm.draft.value.repoUrl)
        assertTrue(!vm.draft.value.canSubmit)
        vm.update { it.copy(name = "Nightly deps", title = "Bump deps", prompt = "Bump them") }
        assertTrue(vm.draft.value.canSubmit)

        var saved: TaskConfigRow? = null
        vm.save { saved = it }
        eventually { saved != null }
        val body = server.lastRequest("POST", "/api/task-configs")!!.json.jsonObject
        assertEquals("Nightly deps", body["name"]?.stringValue)
        assertTrue("agentType" !in body && "promptTemplateId" !in body && "description" !in body)
        assertEquals("100", body["priority"].toString())
        assertEquals("3", body["maxRetries"].toString())
    }
}
