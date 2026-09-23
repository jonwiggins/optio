package dev.optio.feature.tasks

import androidx.lifecycle.ViewModelStore
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.tasks.common.UiMessage
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.data.TriggerOwner
import dev.optio.feature.tasks.data.createTrigger
import dev.optio.feature.tasks.data.listTriggers
import dev.optio.feature.tasks.data.taskEvents
import dev.optio.feature.tasks.job.JobDetailViewModel
import dev.optio.feature.tasks.job.JobFormViewModel
import dev.optio.feature.tasks.job.JobRunViewModel
import dev.optio.feature.tasks.job.JobSaved
import dev.optio.feature.tasks.scheduled.ScheduledDetailViewModel
import dev.optio.feature.tasks.task.TaskDetailViewModel
import java.io.File
import java.util.UUID
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertNotNull
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonObject
import org.junit.Assume.assumeTrue
import org.junit.Rule

/**
 * The screens' ViewModels against a real private test API (PLAN §6, §8): real HTTP, real
 * WebSockets, the fake agent runtime. Skipped unless `OPTIO_TEST_API_URL` is set; the seed ids
 * come from `OPTIO_TEST_SEED`, else `~/.android/optio-devlab/test-api/<port>/seed.json`.
 *
 * ```
 * apps/android/scripts/test-api.sh start --port 4964
 * OPTIO_TEST_API_URL=http://127.0.0.1:4964 ./gradlew :feature:tasks:testDebugUnitTest --tests '*LiveTasksTest*'
 * ```
 *
 * It writes to the test API (retries a task, runs a job, creates and deletes a job and
 * triggers), so point it at a private instance, never the shared one or a real server.
 */
class LiveTasksTest {
    @get:Rule val main = RealMainRule()

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val store = ViewModelStore()

    @AfterTest
    fun tearDown() = main.onMain { store.clear() }

    private fun seed(): JsonObject {
        val url = checkNotNull(baseUrl)
        val port = url.substringAfterLast(':').takeWhile { it.isDigit() }
        val file = listOfNotNull(
            System.getenv("OPTIO_TEST_SEED"),
            File(System.getProperty("user.home"), ".android/optio-devlab/test-api/$port/seed.json").path,
        ).map(::File).firstOrNull { it.isFile } ?: error("no seed.json for $url (set OPTIO_TEST_SEED)")
        return kotlinx.serialization.json.Json.parseToJsonElement(file.readText()).jsonObject
    }

    private fun JsonObject.path(vararg keys: String): String {
        var el: kotlinx.serialization.json.JsonElement = this
        for (k in keys) el = el[k] ?: error("seed.json has no ${keys.joinToString(".")}")
        return checkNotNull(el.stringValue)
    }

    private fun api(seed: JsonObject): ApiClient = ApiClient(baseUrl, seed["api"]?.get("token")?.stringValue ?: "dev")

    @Test
    fun retryAFailedTask() = main.onMain(timeout = 60.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val taskId = seed.path("tasks", "failed", "id")
        val vm = store.make { TaskDetailViewModel(api, taskId) }
        vm.load()
        vm.state.await(15.seconds) { it is LoadState.Loaded }
        // The first run of this test sees `failed`; a later one may catch an earlier retry in flight.
        withTimeout(30.seconds) {
            while (vm.state.value.value?.state != "failed") {
                delay(500)
                vm.refresh()
            }
        }
        assertTrue(vm.state.value.value!!.canRetry)
        val retriesBefore = api.taskEvents(taskId).count { it.trigger == "user_retry" }

        vm.retry()
        vm.busy.await { !it }
        // The retry is recorded (the fake agent then fails the task again).
        withTimeout(30.seconds) {
            while (api.taskEvents(taskId).count { it.trigger == "user_retry" } <= retriesBefore) delay(300)
        }
        val events = api.taskEvents(taskId)
        assertTrue(events.any { it.trigger == "user_retry" && it.toState == "queued" })
    }

    @Test
    fun runAJobAndWatchTheRunComplete() = main.onMain(timeout = 90.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val jobId = seed.path("jobs", "main", "id")
        val detailVm = store.make { JobDetailViewModel(api, jobId) }
        detailVm.load()
        val before = detailVm.state.await(15.seconds) { it is LoadState.Loaded }.value!!
        assertEquals("Nightly release notes", before.job.name)

        val run = detailVm.runJob(mapOf("mode" to JsonPrimitive("[[mock:cost:0.0100]]")))
        assertEquals(UiMessage.Success("Run started"), detailVm.messages.first())
        assertTrue(run.state == "queued" || run.state == "running", run.state)

        // Watch it on the run screen's ViewModel: the socket connects, the run completes.
        val runVm = store.make { JobRunViewModel(api, jobId, run.id) }
        runVm.load()
        runVm.state.await(15.seconds) { it is LoadState.Loaded }
        runVm.logs.start()
        runVm.logs.connected.await(15.seconds) { it }
        withTimeout(60.seconds) {
            while (runVm.state.value.value?.state != "completed") {
                assertTrue(runVm.state.value.value?.state != "failed", "the run failed: ${runVm.state.value.value?.errorMessage}")
                delay(500)
                runVm.refresh()
            }
        }
        val done = runVm.state.value.value!!
        assertEquals("$0.01", done.costText)
        runVm.logs.entries.await(20.seconds) { entries -> entries.any { it.content.contains("Mock agent") } }
        assertEquals("Nightly release notes", runVm.jobName.value)
        runVm.logs.stop()

        // The job page shows it completed once it refetches.
        detailVm.load()
        detailVm.state.await(15.seconds) { state -> state.value?.runs?.any { it.id == run.id && it.state == "completed" } == true }
    }

    @Test
    fun createAndDeleteTriggersOnTheScheduledBlueprint() = main.onMain(timeout = 60.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val configId = seed.path("scheduled", "id")
        val vm = store.make { ScheduledDetailViewModel(api, configId) }
        vm.load()
        val before = vm.state.await(15.seconds) { it is LoadState.Loaded }.value!!.triggers.size

        // A schedule, then a GitHub event trigger (the server needs a login for review requests).
        vm.addTrigger(TriggerDraft.new(TriggerKind.SCHEDULE).withString("cronExpression", "30 8 * * 1-5"))
        assertEquals(UiMessage.Success("Trigger added"), vm.messages.first())
        val github = TriggerDraft.new(TriggerKind.GITHUB).toggleEvent("review_requested", true).withString("login", "ada")
        vm.addTrigger(github)
        assertEquals(UiMessage.Success("Trigger added"), vm.messages.first())
        val added = vm.state.value.value!!.triggers
        assertEquals(before + 2, added.size)
        val schedule = added.single { it.cronExpression == "30 8 * * 1-5" }
        assertNotNull(schedule.nextFireAt, "the server schedules the next firing")
        val event = added.single { it.kind == TriggerKind.GITHUB }
        assertEquals("ada", event.config?.get("login")?.stringValue)

        // Pause one, then delete both.
        vm.setTriggerEnabled(schedule, false)
        vm.busy.await { !it }
        withTimeout(10.seconds) {
            while (api.listTriggers(TriggerOwner.TASK_CONFIG, configId).single { it.id == schedule.id }.enabled) delay(200)
        }
        vm.deleteTrigger(schedule)
        assertEquals(UiMessage.Success("Trigger deleted"), vm.messages.first())
        vm.busy.await { !it }
        vm.deleteTrigger(event)
        assertEquals(UiMessage.Success("Trigger deleted"), vm.messages.first())
        vm.busy.await { !it }
        val remaining = api.listTriggers(TriggerOwner.TASK_CONFIG, configId)
        assertEquals(before, remaining.size)
        assertTrue(remaining.none { it.id == schedule.id || it.id == event.id })

        // The server's own rules come back as readable errors.
        val bad = assertFailsWith<ApiError> {
            api.createTrigger(TriggerOwner.TASK_CONFIG, configId, "slack", JsonObject(mapOf("channelId" to JsonPrimitive("general"))), true)
        }
        assertEquals(400, bad.status)
        assertTrue("channelId" in bad.message, bad.message)
    }

    @Test
    fun createAJobWithAWebhookThenDeleteIt() = main.onMain(timeout = 60.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val path = "a3-live-" + UUID.randomUUID().toString().take(8)
        val form = store.make { JobFormViewModel(api, null) }
        form.update { it.copy(name = "A3 live job $path", promptTemplate = "Summarise {{TOPIC}} [[mock:cost:0.0010]]").addTrigger() }
        val key = form.draft.value.triggers.single().key
        form.update { d -> d.withTrigger(key) { it.withType(TriggerKind.WEBHOOK).withString("path", path) } }
        var saved: JobSaved? = null
        form.save { saved = it }
        eventually(20.seconds) { saved != null || form.error.value != null }
        assertEquals(null, form.error.value)
        val job = saved!!.job
        assertTrue(saved.created)
        val hook = api.listTriggers(TriggerOwner.JOB, job.id).single()
        assertEquals(path, hook.webhookPath)
        assertEquals("string", job.paramsSchema?.get("properties")?.get("TOPIC")?.get("type")?.stringValue)

        // A second webhook on the same path is refused (409) and reported, not duplicated.
        val dupe = assertFailsWith<ApiError> {
            api.createTrigger(TriggerOwner.JOB, job.id, "webhook", JsonObject(mapOf("path" to JsonPrimitive(path))), true)
        }
        assertEquals(409, dupe.status)

        val detail = store.make { JobDetailViewModel(api, job.id) }
        detail.load()
        detail.state.await(15.seconds) { it is LoadState.Loaded }
        detail.delete()
        assertEquals(UiMessage.Success("Job deleted"), detail.messages.first())
        assertEquals(UiMessage.Close, detail.messages.first())
        val gone = assertFailsWith<ApiError> { api.get<kotlinx.serialization.json.JsonElement>("/api/jobs/${job.id}") }
        assertEquals(404, gone.status)
        assertIs<ApiError>(gone)
    }

    @Test
    fun liveTaskFramesArriveOnceAndEndUpTyped() = main.onMain(timeout = 90.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        // A task whose agent prints its init line, waits 4 s, then prints its reply and result: the
        // last two reach the socket live, untyped (the server's `task:log` carries no logType).
        val created = api.post<JsonObject>(
            "/api/tasks",
            mapOf(
                "title" to "A3 live stream check",
                "prompt" to "Stream check [[mock:sleep:4000]] [[mock:cost:0.0100]]",
                "repoUrl" to seed.path("repos", "main", "repoUrl"),
                "agentType" to "claude-code",
            ),
        )
        val taskId = checkNotNull(created["task"]?.get("id")?.stringValue)
        val vm = store.make { TaskDetailViewModel(api, taskId) }
        vm.load()
        vm.logs.start()
        vm.logs.connected.await(15.seconds) { it }
        // The result line ends up as its typed stored row (info), once.
        val entries = vm.logs.entries.await(45.seconds) { list -> list.any { it.content.startsWith("(1 turns") && it.type.raw == "info" } }
        val contents = entries.map { it.content }
        assertEquals(contents.distinct(), contents, "no line twice")
        assertTrue(entries.any { it.content.startsWith("Mock agent handled") && it.type.raw == "text" })
        assertEquals("system", entries.first().type.raw)
        vm.logs.stop()
        runCatching { api.post("/api/tasks/$taskId/cancel") }
    }

    @Test
    fun theLiveLogSocketConnectsAndHistoryLoads() = main.onMain(timeout = 45.seconds) {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val seed = seed()
        val api = api(seed)
        val vm = store.make { TaskDetailViewModel(api, seed.path("tasks", "prOpened", "id")) }
        vm.load()
        vm.state.await(15.seconds) { it is LoadState.Loaded }
        vm.logs.start()
        vm.logs.connected.await(15.seconds) { it }
        val entries = vm.logs.entries.await(15.seconds) { it.isNotEmpty() }
        assertTrue(entries.any { it.content.startsWith("Opened pull request") })
        // Stored rows arrive typed (the catch-up replay on the socket is ignored).
        assertEquals("system", entries.first().type.raw)
        vm.logs.stop()
        assertTrue(!vm.logs.connected.value)
    }
}
