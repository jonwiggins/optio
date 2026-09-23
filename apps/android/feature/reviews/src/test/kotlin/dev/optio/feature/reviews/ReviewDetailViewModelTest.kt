package dev.optio.feature.reviews

import androidx.lifecycle.viewModelScope
import dev.optio.core.model.doubleValue
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.WebSocketClient
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.testing.Samples
import dev.optio.core.ui.state.LoadState
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue
import kotlin.time.Duration.Companion.milliseconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.test.runTest
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import org.junit.Rule

/** One PR review against the fake API (iOS `ReviewDetailModel`). */
class ReviewDetailViewModelTest {
    @get:Rule
    val main = MainDispatcherRule()

    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server
    private val id = "7c9e6679-7425-40de-944b-e07fc1f90ae7"

    private fun routes(review: String = "pr-review-ready.json") {
        server.fixture("/api/pr-reviews/$id", review)
        server.fixture("/api/pr-reviews/$id/runs", "pr-review-runs.json")
        server.fixture("/api/pr-reviews/$id/chat", "pr-review-chat.json")
        server.fixture("/api/pull-requests/status", "pr-status.json")
        server.fixture("/api/pr-reviews/$id/logs", "pr-review-logs.json")
    }

    private fun reviewing(): String {
        val ready = Fixtures.text("pr-review-ready.json")
        return ready.replace("\"state\": \"ready\"", "\"state\": \"reviewing\"").replace("\"verdict\": \"request_changes\"", "\"verdict\": null")
    }

    private fun model(api: ApiClient = server.client()) = ReviewDetailViewModel(
        api = api,
        reviewId = id,
        openSocket = { path -> WebSocketClient(api.wsUrl(path), tokenProvider = { "tok" }, autoReconnect = false) },
        chatPollInterval = 10.milliseconds,
        clock = { Samples.NOW },
    )

    @Test
    fun loadsTheReviewRunsStatusAndChatAndOpensOnTheDraft() = runTest(main.dispatcher) {
        routes()
        val vm = model()
        val review = vm.review.first { it is LoadState.Loaded }.value!!
        assertEquals("ready", review.state)
        assertEquals(ReviewDetailViewModel.Tab.DRAFT, vm.tab.value, "a review with a draft opens on it")
        assertEquals(listOf("run-chat-2", "run-initial-1"), vm.runs.value.map { it.id })
        val draft = vm.draft.value
        assertEquals("request_changes", draft.verdict)
        assertTrue(draft.summary.startsWith("The pagination works"))
        assertEquals(listOf("128", "41"), draft.comments.map { it.line })
        assertFalse(draft.dirty)
        assertEquals("failing", vm.prStatus.first { it != null }!!.checksStatus)
        assertEquals(
            "https://github.com/e2e-org/e2e-repo/pull/138",
            server.lastRequest("GET", "/api/pull-requests/status")!!.queryParam("prUrl"),
        )
        val turns = vm.userMessages.first { it.isNotEmpty() }
        assertEquals(listOf("Is the limit cap really needed?"), turns.map { it.text })
        assertEquals(ReviewDetailViewModel.UserMessage.Status.SENT, turns.single().status)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aReviewInFlightOpensOnTheActivity() = runTest(main.dispatcher) {
        routes()
        server.json("/api/pr-reviews/$id", reviewing())
        val vm = model()
        val review = vm.review.first { it is LoadState.Loaded }.value!!
        assertTrue(review.isWorking)
        assertEquals(ReviewDetailViewModel.Tab.ACTIVITY, vm.tab.value)
        assertEquals(0, server.count("GET", "/api/pr-reviews/$id/chat"), "no draft yet: no chat to read")
        vm.viewModelScope.cancel()
    }

    @Test
    fun saveSendsTheWholeDraft() = runTest(main.dispatcher) {
        routes()
        server.patch("/api/pr-reviews/$id") { FakeResponse.fixture("pr-review-ready.json") }
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.setVerdict("comment")
        vm.setSummary("Looks fine, one nit.")
        val removed = vm.draft.value.comments.last().key
        vm.removeComment(removed)
        vm.addComment()
        val added = vm.draft.value.comments.last().key
        vm.updateComment(added) { it.copy(path = "README.md", line = "7", body = "Typo") }
        assertTrue(vm.draft.value.dirty)

        vm.saveDraft()
        assertEquals(ScreenEvent.Toast("Draft saved"), vm.events.first())
        assertFalse(vm.draft.value.dirty)
        val body = server.lastRequest("PATCH", "/api/pr-reviews/$id")!!.json.jsonObject
        assertEquals("comment", body["verdict"]?.stringValue)
        assertEquals("Looks fine, one nit.", body["summary"]?.stringValue)
        val comments = body["fileComments"]!!.jsonArray.map { it.jsonObject }
        assertEquals(listOf("apps/web/src/app/activity/page.tsx", "README.md"), comments.map { it["path"]?.stringValue })
        assertEquals(7.0, comments[1]["line"]?.doubleValue)
        assertEquals("RIGHT", comments[0]["side"]?.stringValue)
        assertTrue("side" !in comments[1], "an unset side is omitted, not null (the API rejects null)")
        vm.viewModelScope.cancel()
    }

    @Test
    fun submitSavesUnsavedEditsFirst() = runTest(main.dispatcher) {
        routes()
        server.patch("/api/pr-reviews/$id") { FakeResponse.fixture("pr-review-ready.json") }
        server.post("/api/pr-reviews/$id/submit") {
            FakeResponse.json(Fixtures.text("pr-review-ready.json").replace("\"state\": \"ready\"", "\"state\": \"submitted\""))
        }
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.setSummary("Ship it")
        vm.submit()
        assertEquals(ScreenEvent.Toast("Draft saved"), vm.events.first())
        assertEquals(ScreenEvent.Toast("Review submitted"), vm.events.first())
        assertEquals(listOf("PATCH", "POST"), server.requests.filter { it.method != "GET" }.map { it.method })
        assertEquals("submitted", vm.review.value.value!!.state)
        assertFalse(vm.busy.value.submitting)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aFailedSaveStopsTheSubmit() = runTest(main.dispatcher) {
        routes()
        server.error("PATCH", "/api/pr-reviews/$id", 400, "Cannot edit review in submitted state")
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.setVerdict("approve")
        vm.submit()
        val failure = assertIs<ScreenEvent.Failure>(vm.events.first())
        assertEquals("Cannot edit review in submitted state", failure.error.message)
        assertEquals(0, server.count("POST", "/api/pr-reviews/$id/submit"))
        assertTrue(vm.draft.value.dirty, "the edits stay")
        vm.viewModelScope.cancel()
    }

    @Test
    fun reReviewCancelAndMerge() = runTest(main.dispatcher) {
        routes()
        server.json("/api/pr-reviews/$id/re-review", """{"review":{}}""", method = "POST", status = 201)
        server.json("/api/pr-reviews/$id/cancel", """{"ok":true}""", method = "POST")
        server.json("/api/pull-requests/merge", """{"merged":true}""", method = "POST")
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.setSummary("edited")

        vm.reReview()
        assertEquals(ScreenEvent.Toast("Re-review started"), vm.events.first())
        assertFalse(vm.draft.value.dirty, "a re-review discards unsaved edits")
        vm.cancel()
        assertEquals(ScreenEvent.Toast("Review cancelled"), vm.events.first())
        vm.merge("rebase")
        assertEquals(ScreenEvent.Toast("PR merged"), vm.events.first())
        val merge = server.lastRequest("POST", "/api/pull-requests/merge")!!.json.jsonObject
        assertEquals("rebase", merge["mergeMethod"]?.stringValue)
        assertEquals("https://github.com/e2e-org/e2e-repo/pull/138", merge["prUrl"]?.stringValue)
        vm.busy.first { !it.merging } // after the PR's status is re-read
        vm.viewModelScope.cancel()
    }

    @Test
    fun aFailedFirstLoadShowsInPlaceThenRetries() = runTest(main.dispatcher) {
        server.error("GET", "/api/pr-reviews/$id", 404, "PR review not found")
        server.json("/api/pr-reviews/$id/runs", """{"runs":[]}""")
        val vm = model()
        val failed = vm.review.first { it is LoadState.Failed }
        assertIs<LoadState.Failed<*>>(failed)
        routes()
        vm.retry()
        assertEquals("ready", vm.review.first { it is LoadState.Loaded }.value!!.state)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aQuietReloadFailureToastsAndKeepsTheReview() = runTest(main.dispatcher) {
        routes()
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        server.error("GET", "/api/pr-reviews/$id", 500, "boom")
        vm.refresh()
        assertIs<ScreenEvent.Failure>(vm.events.first())
        assertEquals("ready", vm.review.value.value!!.state)
        vm.viewModelScope.cancel()
    }

    @Test
    fun aChatTurnShowsAtOnceThenWaitsForTheReply() = runTest(main.dispatcher) {
        routes()
        val posted = AtomicBoolean(false)
        val chatReads = AtomicInteger(0)
        server.post("/api/pr-reviews/$id/chat") {
            posted.set(true)
            FakeResponse.json("""{"runId":"run-chat-3","prReviewId":"$id"}""", 201)
        }
        server.get("/api/pr-reviews/$id/chat") {
            val base = Fixtures.text("pr-review-chat.json")
            // The reply lands on the second poll after the post.
            if (posted.get() && chatReads.incrementAndGet() >= 2) {
                FakeResponse.json(
                    base.replace(
                        "\n  ]",
                        """,
                    {"id":"chat-3","prReviewId":"$id","runId":"run-chat-3","role":"user","content":"And the offset?","createdAt":"2026-09-22T16:39:00.000Z"},
                    {"id":"chat-4","prReviewId":"$id","runId":"run-chat-3","role":"assistant","content":"Reset it in the filter handler.","createdAt":"2026-09-22T16:39:30.000Z"}
                  ]""",
                    ),
                )
            } else {
                FakeResponse.json(base)
            }
        }
        val vm = model()
        vm.userMessages.first { it.size == 1 }

        vm.sendChat("And the offset?")
        val body = server.lastRequest("POST", "/api/pr-reviews/$id/chat")!!.json.jsonObject
        assertEquals("And the offset?", body["message"]?.stringValue)
        val sent = vm.userMessages.value.last()
        assertEquals("And the offset?", sent.text)
        assertTrue(sent.id.startsWith("local-"))
        assertEquals(ReviewDetailViewModel.UserMessage.Status.SENT, sent.status)
        assertTrue(vm.busy.value.chatSending, "waiting for the reply")

        vm.busy.first { !it.chatSending }
        val turns = vm.userMessages.first { list -> list.none { it.id.startsWith("local-") } }
        assertEquals(listOf("Is the limit cap really needed?", "And the offset?"), turns.map { it.text }, "the echo gives way to the stored turn")
        vm.viewModelScope.cancel()
    }

    @Test
    fun aRejectedChatTurnIsMarkedFailed() = runTest(main.dispatcher) {
        routes()
        server.error("POST", "/api/pr-reviews/$id/chat", 400, "Cannot chat while a review is still being generated")
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.sendChat("hello?")
        assertEquals(ReviewDetailViewModel.UserMessage.Status.FAILED, vm.userMessages.value.last().status)
        assertFalse(vm.busy.value.chatSending)
        val failure = assertIs<ScreenEvent.Failure>(vm.events.first())
        assertEquals("Cannot chat while a review is still being generated", failure.error.message)
        vm.viewModelScope.cancel()
    }

    @Test
    fun theLiveFeedReadsTheLatestRunsLogs() = runTest(main.dispatcher) {
        routes()
        val endpoint = server.webSocket("/ws/pr-reviews/$id/logs")
        val vm = model()
        vm.review.first { it is LoadState.Loaded }
        vm.startLive()
        val socket = withContext(Dispatchers.IO) { endpoint.awaitConnection() }
        assertTrue(socket.request.header("Sec-WebSocket-Protocol")!!.contains("optio-auth-tok"))
        vm.logs.connected.first { it }
        val entries = vm.logs.entries.first { it.size == 4 }
        assertEquals("Reviewing e2e-org/e2e-repo#138 at c41d0a9", entries.first().content)
        vm.stopLive()
        assertFalse(vm.logs.isStarted)
        vm.viewModelScope.cancel()
    }
}
