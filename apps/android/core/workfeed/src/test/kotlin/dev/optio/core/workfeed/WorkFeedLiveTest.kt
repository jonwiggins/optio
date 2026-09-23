package dev.optio.core.workfeed

import dev.optio.core.navigation.WorkView
import dev.optio.core.network.ApiClient
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue
import kotlinx.coroutines.runBlocking
import org.junit.Assume.assumeTrue

/**
 * The feed against the real private test API (PLAN §6, §8), DevLab seed. Skipped unless
 * `OPTIO_TEST_API_URL` is set; the token defaults to `dev` (auth disabled), else
 * `OPTIO_TEST_API_TOKEN`.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4962 ./gradlew :core:workfeed:testDebugUnitTest --tests '*LiveTest*' --rerun
 * ```
 */
class WorkFeedLiveTest {
    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val token: String = System.getenv("OPTIO_TEST_API_TOKEN") ?: "dev"

    @Test
    fun theSeededServerProjectsEveryKindOfWork() = runBlocking {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val api = ApiClient(baseUrl, token)
        val sources = api.workFeedSources()
        assertTrue(sources.unified.isNotEmpty(), "unified tasks")
        assertTrue(sources.hosts.isNotEmpty(), "local hosts")

        val rows = WorkFeed.collect(sources)
        assertEquals(WorkSource.entries.toSet(), rows.map { it.source }.toSet(), "every kind of work is in the feed")
        assertEquals(rows, WorkFeed.sort(rows), "rows arrive sorted")
        assertTrue(rows.zipWithNext().all { (a, b) -> a.status.ordinal <= b.status.ordinal }, "status rank order")
        assertTrue(rows.all { it.sourceId.isNotEmpty() && it.name.isNotEmpty() }, "ids and names decode")
        assertTrue(rows.any { it.status == WorkStatus.NEEDS_YOU }, "the seed has something waiting on you")
        assertTrue(rows.count { WorkFeed.inView(it, WorkView.RECURRING) } >= 4, "jobs, the scheduled task and the automation")
        // A terminal that runs a Repo Task is only its task row.
        val taskIds = rows.filter { it.source == WorkSource.REPO_TASK }.map { it.sourceId }.toSet()
        assertTrue(sources.localTerminals.filter { !it.taskId.isNullOrEmpty() }.all { it.taskId in taskIds })
        assertTrue(rows.none { it.source == WorkSource.LOCAL_TERMINAL && it.sourceId in sources.localTerminals.filter { t -> t.taskId != null }.map { t -> t.id } })
    }
}
