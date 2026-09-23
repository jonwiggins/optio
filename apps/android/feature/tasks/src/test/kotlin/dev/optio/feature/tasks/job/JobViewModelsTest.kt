package dev.optio.feature.tasks.job

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
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.eventually
import dev.optio.feature.tasks.fastSockets
import dev.optio.feature.tasks.make
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/** The Job detail, run and form ViewModels against a fake API serving captured fixtures. */
class JobViewModelsTest {
    @get:Rule val fake = FakeOptioServerRule()

    @get:Rule val main = RealMainRule()

    private val server: FakeOptioServer get() = fake.server
    private val store = ViewModelStore()

    @AfterTest
    fun tearDown() = main.onMain { store.clear() }

    private fun serveJob() {
        server.fixture("/api/jobs/:id", "job-main.json")
        server.fixture("/api/jobs/:id/runs", "job-main-runs.json")
        server.fixture("/api/jobs/:id/triggers", "job-webhook-triggers.json")
    }

    // region Job detail

    @Test
    fun detailLoadsJobRunsAndTriggers() = main.onMain {
        serveJob()
        val api = server.client()
        val vm = store.make { JobDetailViewModel(api, "j1") }
        vm.load()
        val detail = vm.state.await { it is LoadState.Loaded }.value!!
        assertEquals("Nightly release notes", detail.job.name)
        assertEquals(3, detail.runs.size)
        assertEquals(1, detail.activeRunCount)
        assertTrue(detail.hasActiveRuns)
        assertEquals("33%", detail.successRateText)
        assertEquals(1, detail.runs(RunFilter.RUNNING).size)
        assertEquals(1, detail.runs(RunFilter.FAILED).size)
        assertEquals(TriggerKind.WEBHOOK, detail.triggers.single().kind)
        assertEquals("50", server.lastRequest("GET", "/api/jobs/j1/runs")!!.queryParam("limit"))
    }

    @Test
    fun triggersAreOptionalButRunsAreNot() = main.onMain {
        serveJob()
        server.error("GET", "/api/jobs/:id/triggers", 500, "boom")
        val api = server.client()
        val ok = store.make { JobDetailViewModel(api, "j1") }
        ok.load()
        assertTrue(ok.state.await { it is LoadState.Loaded }.value!!.triggers.isEmpty())

        server.error("GET", "/api/jobs/:id/runs", 500, "boom")
        val failing = store.make { JobDetailViewModel(api, "j1") }
        failing.load()
        assertIs<LoadState.Failed<*>>(failing.state.await { it is LoadState.Failed })
    }

    @Test
    fun enableDuplicateDeleteAndRun() = main.onMain {
        serveJob()
        server.fixture("/api/jobs/:id", "job-main.json", method = "PATCH")
        server.fixture("/api/jobs/:id/clone", "job-webhook.json", method = "POST", status = 201)
        server.on("DELETE", "/api/jobs/:id") { FakeResponse.empty() }
        server.fixture("/api/jobs/:id/runs", "run-running.json", method = "POST", status = 201)
        val api = server.client()
        val vm = store.make { JobDetailViewModel(api, "j1") }
        vm.load()
        vm.state.await { it is LoadState.Loaded }

        vm.toggleEnabled()
        assertEquals(UiMessage.Success("Job disabled"), vm.messages.first())
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/jobs/j1")!!.body)

        vm.busy.await { !it }
        vm.duplicate()
        assertEquals(UiMessage.Success("Duplicated as Triage Sentry alerts"), vm.messages.first())

        val run = vm.runJob(mapOf("mode" to JsonPrimitive("quick")))
        assertEquals("running", run.state)
        assertEquals("""{"params":{"mode":"quick"}}""", server.lastRequest("POST", "/api/jobs/j1/runs")!!.body)
        assertEquals(UiMessage.Success("Run started"), vm.messages.first())
        vm.runJob(null)
        assertEquals("{}", server.lastRequest("POST", "/api/jobs/j1/runs")!!.body, "no params: an empty body")
        assertEquals(UiMessage.Success("Run started"), vm.messages.first())

        vm.busy.await { !it }
        vm.delete()
        assertEquals(UiMessage.Success("Job deleted"), vm.messages.first())
        assertEquals(UiMessage.Close, vm.messages.first())
    }

    @Test
    fun triggerToggleAddAndDelete() = main.onMain {
        serveJob()
        server.json("/api/jobs/:id/triggers/:triggerId", """{"trigger":{"id":"x","type":"webhook","config":{"path":"p"},"enabled":false}}""", method = "PATCH")
        server.on("DELETE", "/api/jobs/:id/triggers/:triggerId") { FakeResponse.empty() }
        server.json("/api/jobs/:id/triggers", """{"trigger":{"id":"new","type":"schedule","enabled":true}}""", method = "POST", status = 201)
        val api = server.client()
        val vm = store.make { JobDetailViewModel(api, "j1") }
        vm.load()
        val trigger = vm.state.await { it is LoadState.Loaded }.value!!.triggers.single()

        vm.setTriggerEnabled(trigger, false)
        eventually { server.lastRequest("PATCH", "/api/jobs/j1/triggers/${trigger.id}") != null }
        assertEquals("""{"enabled":false}""", server.lastRequest("PATCH", "/api/jobs/j1/triggers/${trigger.id}")!!.body)

        vm.busy.await { !it }
        vm.addTrigger(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "0 9 * * 1-5"))
        val created = server.lastRequest("POST", "/api/jobs/j1/triggers")!!.json.jsonObject
        assertEquals("schedule", created["type"]?.stringValue)
        assertEquals(JsonObject(mapOf("cronExpression" to JsonPrimitive("0 9 * * 1-5"))), created["config"])
        assertEquals("true", created["enabled"].toString())
        assertEquals(UiMessage.Success("Trigger added"), vm.messages.first())

        vm.deleteTrigger(trigger)
        assertEquals(UiMessage.Success("Trigger deleted"), vm.messages.first())
        assertNotNull(server.lastRequest("DELETE", "/api/jobs/j1/triggers/${trigger.id}"))
    }

    // endregion

    // region Job run

    @Test
    fun runLoadsWithTheJobNameAndRetriesAndCancels() = main.onMain {
        server.fixture("/api/workflow-runs/:id", "run-failed.json")
        server.fixture("/api/jobs/:id", "job-main.json")
        server.fixture("/api/workflow-runs/:id/logs", "run-failed-logs.json")
        server.fixture("/api/workflow-runs/:id/retry", "run-running.json", method = "POST")
        server.fixture("/api/workflow-runs/:id/cancel", "run-failed.json", method = "POST")
        val endpoint = server.webSocket("/ws/workflow-runs/:id/logs")
        val api = server.client()
        val vm = store.make { JobRunViewModel(api, "j1", "r1", fastSockets(api)) }
        vm.load()
        val run = vm.state.await { it is LoadState.Loaded }.value!!
        assertEquals("failed", run.state)
        assertTrue(run.canRetry)
        assertEquals("Nightly release notes", vm.jobName.await { it != null })

        vm.logs.start()
        vm.logs.entries.await { it.isNotEmpty() }
        withContext(Dispatchers.IO) { endpoint.awaitConnection() }

        vm.retry()
        vm.state.await { it.value?.state == "running" }
        assertNotNull(server.lastRequest("POST", "/api/workflow-runs/r1/retry"))
        vm.busy.await { !it }
        vm.cancel()
        vm.state.await { it.value?.state == "failed" }
        assertNotNull(server.lastRequest("POST", "/api/workflow-runs/r1/cancel"))
        vm.logs.stop()
    }

    @Test
    fun aFailedRefreshKeepsTheRunOnScreen() = main.onMain {
        val calls = AtomicInteger()
        server.get("/api/workflow-runs/:id") {
            if (calls.getAndIncrement() == 0) FakeResponse.fixture("run-running.json") else FakeResponse.error(500, "boom")
        }
        server.fixture("/api/jobs/:id", "job-main.json")
        val api = server.client()
        val vm = store.make { JobRunViewModel(api, "j1", "r1", fastSockets(api)) }
        vm.load()
        vm.state.await { it is LoadState.Loaded }
        vm.refresh()
        eventually { calls.get() >= 2 }
        assertEquals("running", vm.state.value.value?.state)
        assertIs<LoadState.Loaded<*>>(vm.state.value)
    }

    // endregion

    // region Job form

    @Test
    fun createSavesTheJobThenItsTriggers() = main.onMain {
        server.json("/api/jobs", Fixtures.text("job-main.json"), method = "POST", status = 201)
        server.json("/api/jobs/:id/triggers", """{"trigger":{"id":"tr1","type":"webhook","config":{"path":"nightly"},"enabled":true}}""", method = "POST", status = 201)
        val api = server.client()
        val vm = store.make { JobFormViewModel(api, null) }
        assertIs<LoadState.Loaded<*>>(vm.loading.value)
        vm.update { it.copy(name = "Nightly release notes", promptTemplate = "Notes for {{REPO}}").addTrigger() }
        val key = vm.draft.value.triggers.single().key
        vm.update { d -> d.withTrigger(key) { it.withType(TriggerKind.WEBHOOK).withString("path", "nightly") } }
        var saved: JobSaved? = null
        vm.save { saved = it }
        eventually { saved != null }
        assertTrue(saved!!.created)
        val body = server.lastRequest("POST", "/api/jobs")!!.json.jsonObject
        assertEquals("Nightly release notes", body["name"]?.stringValue)
        assertTrue(body["paramsSchema"] is JsonObject)
        val trigger = server.lastRequest("POST", "/api/jobs/${saved.job.id}/triggers")!!.json.jsonObject
        assertEquals("webhook", trigger["type"]?.stringValue)
        assertEquals(JsonObject(mapOf("path" to JsonPrimitive("nightly"))), trigger["config"])
    }

    @Test
    fun aFailedTriggerStepNeverCreatesASecondJob() = main.onMain {
        server.json("/api/jobs", Fixtures.text("job-main.json"), method = "POST", status = 201)
        server.error("POST", "/api/jobs/:id/triggers", 409, "Webhook path \"taken\" is already in use")
        server.fixture("/api/jobs/:id", "job-main.json", method = "PATCH")
        val api = server.client()
        val vm = store.make { JobFormViewModel(api, null) }
        vm.update { it.copy(name = "N", promptTemplate = "Go").addTrigger() }
        val key = vm.draft.value.triggers.single().key
        vm.update { d -> d.withTrigger(key) { it.withType(TriggerKind.WEBHOOK).withString("path", "taken") } }
        vm.save { error("should not finish") }
        val error = vm.error.await { it != null }!!
        assertEquals("Webhook path \"taken\" is already in use", error.message)
        assertTrue(vm.draft.value.isEdit, "the form now edits the job it created")

        // Fix the path and save again: the job is patched, not created twice.
        server.json("/api/jobs/:id/triggers", """{"trigger":{"id":"tr1","type":"webhook","config":{"path":"free"},"enabled":true}}""", method = "POST", status = 201)
        vm.update { d -> d.withTrigger(key) { it.withString("path", "free") } }
        var saved: JobSaved? = null
        vm.save { saved = it }
        eventually { saved != null }
        assertEquals(1, server.count("POST", "/api/jobs"))
        assertEquals(1, server.count("PATCH", "/api/jobs/${saved!!.job.id}"))
        assertTrue(saved.created, "still reported as created, so the screen opens the new job")
        assertNull(vm.error.value)
    }

    @Test
    fun editLoadsTheJobAndDiffsTriggers() = main.onMain {
        server.fixture("/api/jobs/:id", "job-webhook.json")
        server.fixture("/api/jobs/:id/triggers", "job-webhook-triggers.json")
        server.fixture("/api/jobs/:id", "job-webhook.json", method = "PATCH")
        server.on("DELETE", "/api/jobs/:id/triggers/:triggerId") { FakeResponse.empty() }
        server.json("/api/jobs/:id/triggers", """{"trigger":{"id":"tr2","type":"schedule","config":{"cronExpression":"0 9 * * 1"},"enabled":true}}""", method = "POST", status = 201)
        server.json("/api/jobs/:id/triggers/:triggerId", """{"trigger":{"id":"x","type":"webhook","config":{"path":"p"},"enabled":false}}""", method = "PATCH")
        val api = server.client()
        val vm = store.make { JobFormViewModel(api, "j2") }
        vm.load()
        vm.loading.await { it is LoadState.Loaded }
        val draft = vm.draft.value
        assertTrue(draft.isEdit)
        assertEquals("Triage Sentry alerts", draft.name)
        val hook = draft.triggers.single()
        assertEquals(TriggerKind.WEBHOOK, hook.type)

        // Unchanged: saving touches no trigger.
        var saved: JobSaved? = null
        vm.save { saved = it }
        eventually { saved != null }
        assertFalse(saved!!.created)
        val id = saved!!.job.id
        assertEquals(0, server.count("POST", "/api/jobs/$id/triggers") + server.count("DELETE") + server.count("PATCH", "/api/jobs/$id/triggers/*"))

        // A type change is delete + create.
        vm.update { d -> d.withTrigger(hook.key) { it.withType(TriggerKind.SCHEDULE).withString("cronExpression", "0 9 * * 1") } }
        saved = null
        vm.save { saved = it }
        eventually { saved != null }
        assertEquals(1, server.count("DELETE", "/api/jobs/$id/triggers/${hook.existingId}"))
        assertEquals(1, server.count("POST", "/api/jobs/$id/triggers"))
        assertEquals("tr2", vm.draft.value.triggers.single().existingId, "the draft now points at the new row")
    }

    // endregion
}
