package dev.optio.feature.tasks.task

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
import dev.optio.feature.tasks.eventually
import dev.optio.feature.tasks.fastSockets
import dev.optio.feature.tasks.make
import kotlin.test.AfterTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/**
 * The task detail against a fake API serving the fixtures captured from the private test API:
 * loading, what each state allows, and every action's request.
 */
class TaskDetailViewModelTest {
    @get:Rule val fake = FakeOptioServerRule()

    @get:Rule val main = RealMainRule()

    private val server: FakeOptioServer get() = fake.server
    private val store = ViewModelStore()

    @AfterTest
    fun tearDown() = main.onMain { store.clear() }

    /** Serves the task [fixture] (plus its events / subtasks / activity when captured) under id `t1`. */
    private fun serve(fixture: String, extras: Boolean = true): dev.optio.core.testing.FakeSocketEndpoint {
        server.fixture("/api/tasks/:id", "task-$fixture.json")
        if (extras && fixture == "prOpened") {
            server.fixture("/api/tasks/:id/events", "task-prOpened-events.json")
            server.fixture("/api/tasks/:id/subtasks", "task-prOpened-subtasks.json")
            server.fixture("/api/tasks/:id/activity", "task-prOpened-activity.json")
            server.fixture("/api/tasks/:id/logs", "task-prOpened-logs.json")
        } else {
            server.json("/api/tasks/:id/events", """{"events":[]}""")
            server.json("/api/tasks/:id/subtasks", """{"subtasks":[]}""")
            server.json("/api/tasks/:id/activity", """{"activity":[]}""")
            server.json("/api/tasks/:id/logs", """{"logs":[]}""")
        }
        server.json("/api/tasks/:id/dependencies", """{"dependencies":[]}""")
        server.fixture("/api/tasks/:id/dependents", "task-prOpened-dependents.json")
        val socket = server.webSocket("/ws/logs/:taskId")
        server.json("/api/tasks/:id/:action", """{"task":null}""", method = "POST")
        return socket
    }

    private fun vm(): TaskDetailViewModel {
        val api = server.client()
        return store.make { TaskDetailViewModel(api, "t1", fastSockets(api)) }
    }

    private suspend fun TaskDetailViewModel.loaded(): TaskDetail {
        load()
        return state.await { it is LoadState.Loaded }.value!!
    }

    @Test
    fun loadsTheTaskAndItsSurroundings() = main.onMain {
        serve("prOpened")
        val detail = vm().loaded()
        assertEquals("Add a dark mode toggle to Settings", detail.task.title)
        assertEquals("pr_opened", detail.events.last().toState)
        assertEquals("review", detail.subtasks.single().taskType)
        assertEquals(1, detail.activity.count { it.isComment })
        assertTrue(detail.dependencies.isEmpty())
        // What a PR-opened task allows (iOS TaskDetailModel).
        assertTrue(detail.canRequestReview && detail.canForceRestart && detail.canMessage && detail.showsComposer)
        assertFalse(detail.canCancel || detail.canRetry || detail.canStart || detail.canRunNow || detail.isTerminal)
        assertFalse(detail.canMessageRunning)
    }

    @Test
    fun predicatesForEveryCapturedState() {
        fun d(name: String) = TaskDetail(Fixtures.decode<dev.optio.feature.tasks.data.TaskDetailResponse>("task-$name.json").task)
        with(d("running")) {
            assertTrue(canCancel && canMessageRunning && showsComposer)
            assertFalse(canRetry || isTerminal)
        }
        with(d("failed")) {
            assertTrue(canRetry && canForceRestart && canMessageStopped && isTerminal)
            assertFalse(canCancel)
        }
        with(d("needsAttention")) {
            assertTrue(canCancel && canResume && canForceRestart && canMessage)
            assertFalse(isPlanReview, "no plan_review event")
        }
        with(d("cancelled")) { assertTrue(canRetry && isTerminal && canMessageStopped) }
        with(d("completed")) {
            assertTrue(isTerminal)
            assertFalse(showsComposer || canRetry || canCancel)
        }
        with(d("waitingOnDeps")) { assertFalse(canCancel || canRetry || showsComposer) }
        with(d("queuedLocal")) {
            assertTrue(canCancel && task.isLocal)
            assertFalse(canMessageRunning)
        }
        // A local run never takes mid-turn messages (it types into its terminal).
        val localRunning = d("queuedLocal").let { it.copy(task = it.task.copy(state = "running", agentType = "claude-code")) }
        assertFalse(localRunning.canMessageRunning)
        val planReview = d("needsAttention").copy(events = listOf(dev.optio.feature.tasks.data.TaskEventRow(trigger = "plan_review")))
        assertTrue(planReview.isPlanReview)
        // A completed task with no session can't be resumed.
        assertTrue(d("completed").copy(task = d("completed").task.copy(sessionId = null)).resumeUnavailable)
    }

    @Test
    fun optionalListsDegradeButTheTaskIsRequired() = main.onMain {
        serve("prOpened")
        server.error("GET", "/api/tasks/:id/subtasks", 500, "boom")
        server.error("GET", "/api/tasks/:id/activity", 500, "boom")
        val detail = vm().loaded()
        assertTrue(detail.subtasks.isEmpty() && detail.activity.isEmpty())

        server.error("GET", "/api/tasks/:id", 404, "Task not found")
        val failing = vm()
        failing.load()
        val failed = failing.state.await { it is LoadState.Failed }
        assertIs<LoadState.Failed<*>>(failed)
    }

    @Test
    fun eachActionPostsItsRoute() = main.onMain {
        serve("failed")
        val vm = vm()
        vm.loaded()
        suspend fun expect(path: String, action: () -> Unit, body: String? = null) {
            server.clearRequests()
            action()
            val req = withContext(Dispatchers.IO) { server.awaitRequest("POST", path) }
            if (body != null) assertEquals(body, req.body)
            vm.busy.await { !it }
        }
        expect("/api/tasks/t1/retry", vm::retry)
        expect("/api/tasks/t1/cancel", vm::cancel)
        expect("/api/tasks/t1/retry", vm::start)
        expect("/api/tasks/t1/force-restart", vm::attemptResume, body = "{}")
        expect("/api/tasks/t1/review", vm::requestReview)
        expect("/api/tasks/t1/run-now", vm::runNow)
        expect("/api/tasks/t1/force-redo", vm::forceRedo)
        expect("/api/tasks/t1/resume", vm::approvePlan, body = """{"prompt":"${TaskDetailViewModel.PLAN_APPROVED}"}""")
    }

    @Test
    fun actionsReportSuccessRefreshAndFailure() = main.onMain {
        serve("prOpened")
        val vm = vm()
        vm.loaded()
        val before = server.count("GET", "/api/tasks/t1")
        vm.requestReview()
        assertEquals(UiMessage.Success("Review agent launched"), vm.messages.first())
        eventually { server.count("GET", "/api/tasks/t1") > before }
        // The review action stays busy until its refresh lands, and a busy page ignores new actions.
        eventually { !vm.busy.value }

        server.error("POST", "/api/tasks/:id/retry", 409, "Cannot retry task in pr_opened state")
        vm.retry()
        val failure = assertIs<UiMessage.Failure>(vm.messages.first())
        assertEquals("Cannot retry task in pr_opened state", failure.error.message)
    }

    @Test
    fun forceRedoReloadsTheLogFromScratch() = main.onMain {
        serve("prOpened")
        val vm = vm()
        vm.loaded()
        vm.logs.start()
        vm.logs.entries.await { it.size == 4 }
        server.json("/api/tasks/:id/logs", """{"logs":[]}""")
        vm.forceRedo()
        assertEquals(UiMessage.Success("Task reset and re-queued"), vm.messages.first())
        vm.logs.entries.await { it.isEmpty() }
        eventually { server.count("GET", "/api/tasks/t1/logs") >= 2 }
        vm.logs.loaded.await { it }
        assertTrue(server.requests("GET", "/api/tasks/t1/logs").last().queryParam("offset") == null, "a fresh load, not a tail")
        vm.logs.stop()
    }

    @Test
    fun messagesGoSoftToAStoppedTaskAndAsChosenToARunningOne() = main.onMain {
        serve("prOpened")
        val stopped = vm()
        stopped.loaded()
        stopped.logs.start()
        stopped.logs.loaded.await { it }
        assertTrue(stopped.send("Also cover high contrast", MessageMode.INTERRUPT))
        val soft = server.lastRequest("POST", "/api/tasks/t1/message")!!
        assertEquals("""{"content":"Also cover high contrast","mode":"soft"}""", soft.body, "a stopped task resumes with a soft message")
        val you = stopped.logs.entries.await { it.lastOrNull()?.content == "Also cover high contrast" }.last()
        assertEquals("user", you.metadata?.get("role")?.stringValue)
        stopped.logs.stop()

        store.clear()
        server.resetRoutes()
        serve("running")
        val running = vm()
        running.loaded()
        running.logs.start()
        running.logs.loaded.await { it }
        assertTrue(running.send("Stop and fix the build", MessageMode.INTERRUPT))
        val interrupt = server.lastRequest("POST", "/api/tasks/t1/message")!!
        assertEquals("interrupt", interrupt.json.jsonObject["mode"]?.stringValue)
        running.logs.entries.await { it.lastOrNull()?.content == "[interrupt] Stop and fix the build" }
        running.logs.stop()
    }

    @Test
    fun commentsSubtasksAndDependencies() = main.onMain {
        serve("prOpened")
        server.json("/api/tasks/:id/comments", """{"comment":{}}""", method = "POST", status = 201)
        server.on("DELETE", "/api/tasks/:taskId/comments/:commentId") { FakeResponse.empty() }
        server.json("/api/tasks/:id/subtasks", """{"subtask":{}}""", method = "POST", status = 201)
        server.json("/api/tasks/:id/dependencies", """{"ok":true}""", method = "POST", status = 201)
        server.on("DELETE", "/api/tasks/:id/dependencies/:dep") { FakeResponse.empty() }
        server.fixture("/api/tasks/search", "tasks-search.json")
        val vm = vm()
        vm.loaded()

        assertTrue(vm.addComment("Ship it"))
        assertEquals("""{"content":"Ship it"}""", server.lastRequest("POST", "/api/tasks/t1/comments")!!.body)
        vm.deleteComment("c1")
        withContext(Dispatchers.IO) { server.awaitRequest("DELETE", "/api/tasks/t1/comments/c1") }

        vm.createSubtask(" Write docs ", "Document it", "step", blocksParent = true)
        val sub = server.lastRequest("POST", "/api/tasks/t1/subtasks")!!.json as JsonObject
        assertEquals("Write docs", sub["title"]?.stringValue)
        assertEquals("step", sub["taskType"]?.stringValue)
        assertEquals("true", sub["blocksParent"].toString())

        val candidates = vm.dependencyCandidates("")
        assertTrue(candidates.none { it.id == "t1" })
        assertTrue(candidates.isNotEmpty())
        vm.addDependency(candidates.first().id)
        assertEquals("""{"dependsOnIds":["${candidates.first().id}"]}""", server.lastRequest("POST", "/api/tasks/t1/dependencies")!!.body)
        vm.busy.await { !it }
        vm.removeDependency("d9")
        withContext(Dispatchers.IO) { server.awaitRequest("DELETE", "/api/tasks/t1/dependencies/d9") }
    }

    @Test
    fun aStateFrameOnTheLogSocketRefetchesTheTask() = main.onMain {
        val endpoint = serve("running")
        val vm = vm()
        vm.loaded()
        vm.logs.start()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        val before = server.count("GET", "/api/tasks/t1")
        socket.sendText("""{"type":"task:state_changed","taskId":"t1","fromState":"running","toState":"pr_opened","timestamp":"2026-09-23T00:00:00Z"}""")
        eventually { server.count("GET", "/api/tasks/t1") > before }
        vm.logs.stop()
    }
}
