package dev.optio.feature.reviews

import androidx.lifecycle.viewModelScope
import dev.optio.core.model.intValue
import dev.optio.core.model.stringValue
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.ui.state.LoadState
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/** Work › Inbox and an issue's "Assign to Optio" against the fake API (iOS `IssuesListModel`). */
class InboxViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    private fun routes() {
        server.fixture("/api/issues", "issues.json")
        server.fixture("/api/repos", "repos.json")
    }

    @Test
    fun loadsOpenIssuesWithoutAStateParameter() = runTest(main.dispatcher) {
        routes()
        val vm = InboxViewModel(server.client())
        vm.refresh()
        val issues = vm.issues.first { it is LoadState.Loaded }.value!!
        assertEquals(5, issues.size)
        assertEquals(2, vm.repos.value.size)
        val request = server.lastRequest("GET", "/api/issues")!!
        assertNull(request.queryParam("state"), "open is the server default (iOS sends nothing)")
        assertNull(request.queryParam("repoId"))
        assertEquals(listOf("#7", "#5"), vm.unassigned().map { it.numberText })
        vm.viewModelScope.cancel()
    }

    @Test
    fun filtersRefetchAndReposAreFetchedOnce() = runTest(main.dispatcher) {
        routes()
        val vm = InboxViewModel(server.client())
        vm.reload()
        vm.setState("closed")
        server.nextRequest("GET", "/api/issues")
        val closed = server.nextRequest("GET", "/api/issues")
        assertEquals("closed", closed.queryParam("state"))
        vm.issues.first { it is LoadState.Loaded }
        vm.setRepo("142e78f2-2b76-4205-a498-51a404d04776")
        val byRepo = server.nextRequest("GET", "/api/issues")
        assertEquals("142e78f2-2b76-4205-a498-51a404d04776", byRepo.queryParam("repoId"))
        assertEquals("closed", byRepo.queryParam("state"))
        vm.issues.first { it is LoadState.Loaded }
        vm.setState("all")
        assertEquals("all", server.nextRequest("GET", "/api/issues").queryParam("state"))
        vm.issues.first { it is LoadState.Loaded }
        assertEquals(1, server.count("GET", "/api/repos"))
        vm.viewModelScope.cancel()
    }

    @Test
    fun assigningMarksTheRowAndToasts() = runTest(main.dispatcher) {
        routes()
        server.post("/api/issues/assign") { FakeResponse.fixture("issue-assign.json", 201) }
        val vm = InboxViewModel(server.client())
        vm.reload()
        val issue = vm.issues.value.value!!.first()
        vm.assign(issue)
        assertEquals(ScreenEvent.Toast("Assigned #7 to Optio"), vm.events.first())
        val body = server.lastRequest("POST", "/api/issues/assign")!!.json.jsonObject
        assertEquals(7, body["issueNumber"]?.intValue)
        assertEquals("e3ae92d2-e09c-4e1e-b51f-7803685a1e72", body["repoId"]?.stringValue)
        assertEquals("Crash when the settings screen opens offline", body["title"]?.stringValue)
        assertTrue(body["body"]!!.stringValue!!.startsWith("Steps: turn on airplane mode"))
        assertTrue("agentType" !in body, "no agent: the repo default")
        val marked = vm.issues.value.value!!.first()
        assertEquals("queued", marked.optioTask?.state)
        assertEquals(Fixtures.decode<AssignedTaskEnvelope>("issue-assign.json").task.id, marked.optioTask?.taskId)
        assertEquals(listOf("bug", "android", "optio"), marked.labels)
        assertEquals(listOf("#5"), vm.unassigned().map { it.numberText })
        vm.viewModelScope.cancel()
    }

    @Test
    fun assignAllCountsWhatWentThrough() = runTest(main.dispatcher) {
        routes()
        val calls = AtomicInteger(0)
        server.post("/api/issues/assign") {
            if (calls.incrementAndGet() == 1) FakeResponse.fixture("issue-assign.json", 201) else FakeResponse.error(503, "No git token configured")
        }
        val vm = InboxViewModel(server.client())
        vm.reload()
        vm.assignAll()
        assertEquals(ScreenEvent.Toast("Assigned 1 of 2 issues"), vm.events.first())
        assertEquals(2, server.count("POST", "/api/issues/assign"), "tracker tickets and taken issues are skipped")
        assertEquals(false, vm.bulkBusy.value)
        vm.viewModelScope.cancel()
    }

    @Test
    fun anAssignmentFromTheDetailMarksTheList() = runTest(main.dispatcher) {
        routes()
        server.post("/api/issues/assign") { FakeResponse.fixture("issue-assign.json", 201) }
        val vm = InboxViewModel(server.client())
        vm.reload()
        val issue = vm.issues.value.value!![1]
        val route = issue.toRoute()

        val detail = IssueDetailViewModel(server.client(), route)
        assertTrue(detail.isAssignable)
        detail.setAgentType("codex")
        detail.assign()
        val state = detail.state.first { it.createdTaskId != null }
        assertEquals(false, state.assigning)
        assertEquals("codex", server.lastRequest("POST", "/api/issues/assign")!!.json.jsonObject["agentType"]?.stringValue)
        val marked = vm.issues.first { list -> list.value!![1].optioTask != null }.value!![1]
        assertEquals(state.createdTaskId, marked.optioTask?.taskId)
        vm.viewModelScope.cancel()
        detail.viewModelScope.cancel()
    }

    @Test
    fun aFailedAssignmentStaysOnTheDetail() = runTest(main.dispatcher) {
        server.error("POST", "/api/issues/assign", 404, "Repo not found")
        val issue = Fixtures.decode<IssuesEnvelope>("issues.json").issues.first()
        val detail = IssueDetailViewModel(server.client(), issue.toRoute())
        detail.assign()
        val state = detail.state.first { it.error != null }
        assertEquals("Repo not found", state.error!!.message)
        assertNull(state.createdTaskId)
        detail.viewModelScope.cancel()
    }

    @Test
    fun trackerTicketsAndTakenIssuesCantBeAssignedFromTheDetail() {
        val issues = Fixtures.decode<IssuesEnvelope>("issues.json").issues
        assertEquals(false, IssueDetailViewModel(server.client(), issues[2].toRoute()).isAssignable, "a Linear ticket")
        assertEquals(false, IssueDetailViewModel(server.client(), issues[3].toRoute()).isAssignable, "Optio already has it")
    }

    @Test
    fun aFailedLoadShowsTheError() = runTest(main.dispatcher) {
        server.error("GET", "/api/issues", 500, "boom")
        server.json("/api/repos", """{"repos":[]}""")
        val vm = InboxViewModel(server.client())
        vm.reload()
        assertIs<LoadState.Failed<*>>(vm.issues.value)
        assertTrue(vm.repos.value.isEmpty())
        vm.viewModelScope.cancel()
    }
}
