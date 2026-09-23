package dev.optio.feature.local.transcript

import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.model.LocalTranscriptKind
import dev.optio.core.model.LocalTranscriptRole
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.feature.local.api.LocalTranscriptPage
import dev.optio.feature.local.api.getLocalTerminalTranscript
import java.util.concurrent.CopyOnWriteArrayList
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest
import org.junit.Rule
import org.junit.Test

/**
 * [LocalTranscriptModel] against [dev.optio.core.testing.FakeOptioServer] (real HTTP through
 * `ApiClient`): paging through everything at start, then polling `after=<last seq>` while live, one
 * last fetch when the session ends, pausing while off screen, and tolerating failures.
 */
@OptIn(ExperimentalCoroutinesApi::class)
class LocalTranscriptModelTest {
    @get:Rule
    val rule = FakeOptioServerRule()
    private val server get() = rule.server

    /** What the server has stored; tests append to it to simulate a live session. */
    private val stored = CopyOnWriteArrayList<LocalTranscriptEntry>()
    private val afters = CopyOnWriteArrayList<Long>()
    private var failNext = false

    private fun entry(seq: Int) =
        LocalTranscriptEntry(
            seq = seq.toDouble(),
            role = if (seq == 1) LocalTranscriptRole.USER else LocalTranscriptRole.ASSISTANT,
            kind = LocalTranscriptKind.TEXT,
            text = "entry $seq",
            isError = false,
        )

    private fun serve(vararg seqs: Int) {
        seqs.forEach { stored += entry(it) }
        server.get("/api/local/terminals/:id/transcript") { req ->
            if (failNext) {
                failNext = false
                return@get FakeResponse.error(500, "boom")
            }
            val after = req.queryParam("after")?.toLong() ?: 0L
            val limit = req.queryParam("limit")!!.toInt()
            afters += after
            val page = stored.filter { it.seq.toLong() > after }.take(limit)
            FakeResponse.of(LocalTranscriptPage(page, complete = page.size < limit))
        }
    }

    private fun TestScope.model(pageSize: Int = 5): LocalTranscriptModel {
        val api = server.client()
        return LocalTranscriptModel(
            scope = backgroundScope,
            fetch = { after, limit -> api.getLocalTerminalTranscript("t1", after, limit) },
            pageSize = pageSize,
        )
    }

    /**
     * Waits in real time for HTTP to come back, running what it resumes on the test scheduler
     * without advancing virtual time (runTest would otherwise skip ahead to the next poll while the
     * test body is suspended on I/O).
     */
    private fun TestScope.awaitReal(
        what: String,
        timeoutMs: Long = 5_000,
        condition: () -> Boolean,
    ) {
        val deadline = System.currentTimeMillis() + timeoutMs
        while (true) {
            runCurrent()
            if (condition()) return
            check(System.currentTimeMillis() < deadline) { "timed out waiting for $what" }
            Thread.sleep(10)
        }
    }

    /** Lets in-flight HTTP finish and its continuations run (no virtual time passes). */
    private fun TestScope.settle(ms: Long = 300) {
        val until = System.currentTimeMillis() + ms
        while (System.currentTimeMillis() < until) {
            runCurrent()
            Thread.sleep(10)
        }
    }

    private fun TestScope.awaitLoaded(m: LocalTranscriptModel) = awaitReal("the first load") { m.state.value.loaded }

    private fun TestScope.awaitCount(
        m: LocalTranscriptModel,
        n: Int,
    ) = awaitReal("$n entries") { m.state.value.entries.size == n }

    @Test
    fun pagesThroughEverythingStoredThenPollsPastTheLastSeqWhileLive() =
        runTest {
            serve(*(1..12).toList().toIntArray())
            val m = model(pageSize = 5)
            m.start(live = true)
            awaitLoaded(m)
            val loaded = m.state.value
            assertEquals((1..12).map { "entry $it" }, loaded.entries.map { it.text })
            assertEquals(listOf(0L, 5L, 10L), afters, "three pages: after is the last seq of the page before")

            stored += entry(13)
            stored += entry(14)
            advanceTimeBy(LocalTranscriptModel.LIVE_POLL.inWholeMilliseconds + 1)
            awaitCount(m, 14)
            assertEquals(12L, afters.last(), "a poll asks only for what's new")
        }

    @Test
    fun aSessionThatEndsGetsOneLastFetchAndStopsPolling() =
        runTest {
            serve(1, 2)
            val m = model()
            m.start(live = true)
            awaitLoaded(m)
            stored += entry(3) // the daemon's final flush right before exit
            m.setLive(false)
            awaitCount(m, 3)
            val requests = afters.size
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(requests, afters.size, "no polling once the session is over")
        }

    @Test
    fun aFinishedSessionLoadsOnceAndThenOnlyCatchesUp() =
        runTest {
            serve(1, 2, 3)
            val m = model()
            m.start(live = false)
            awaitLoaded(m)
            // The one catch-up fetch after the initial load.
            awaitReal("the catch-up fetch") { afters.size >= 2 }
            assertEquals(listOf(0L, 3L), afters)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(2, afters.size)
        }

    @Test
    fun pausingStopsThePollAndResumingCatchesUp() =
        runTest {
            serve(1)
            val m = model()
            m.start(live = true)
            awaitLoaded(m)
            m.pause()
            stored += entry(2)
            advanceTimeBy(60_000)
            runCurrent()
            assertEquals(1, m.state.value.entries.size, "nothing fetched while off screen")
            m.resume()
            awaitCount(m, 2)
        }

    @Test
    fun aFailedPollIsRetriedOnTheNextTick() =
        runTest {
            serve(1)
            val m = model()
            m.start(live = true)
            awaitLoaded(m)
            stored += entry(2)
            failNext = true
            advanceTimeBy(LocalTranscriptModel.LIVE_POLL.inWholeMilliseconds + 1)
            awaitReal("the failed poll") { !failNext }
            settle()
            assertEquals(1, m.state.value.entries.size)
            advanceTimeBy(LocalTranscriptModel.LIVE_POLL.inWholeMilliseconds + 1)
            awaitCount(m, 2)
        }

    @Test
    fun noTranscriptMeansLoadedAndEmpty() =
        runTest {
            server.error("GET", "/api/local/terminals/:id/transcript", 404, "Terminal not found")
            val m = model()
            m.start(live = false)
            awaitLoaded(m)
            val state = m.state.value
            assertTrue(state.entries.isEmpty())
            assertEquals(false, state.hasEntries)
        }

    @Test
    fun pokeFetchesNowWithoutWaitingForTheTick() =
        runTest {
            serve(1)
            val m = model()
            m.start(live = true)
            awaitLoaded(m)
            stored += entry(2)
            m.poke()
            awaitCount(m, 2)
        }
}
