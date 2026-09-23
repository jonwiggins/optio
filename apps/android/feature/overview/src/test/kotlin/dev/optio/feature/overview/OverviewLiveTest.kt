package dev.optio.feature.overview

import dev.optio.core.network.ApiClient
import dev.optio.core.testing.MainDispatcherRule
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.workFeedSources
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import org.junit.Assume.assumeTrue
import org.junit.Rule

/**
 * The Overview against the real private test API (PLAN §6, §8), DevLab seed. Skipped unless
 * `OPTIO_TEST_API_URL` is set; the token defaults to `dev` (auth disabled), else
 * `OPTIO_TEST_API_TOKEN`.
 *
 * ```
 * OPTIO_TEST_API_URL=http://127.0.0.1:4962 ./gradlew :feature:overview:testDebugUnitTest --tests '*LiveTest*' --rerun
 * ```
 */
@OptIn(ExperimentalCoroutinesApi::class)
class OverviewLiveTest {
    @get:Rule
    val main = MainDispatcherRule(UnconfinedTestDispatcher())

    private val baseUrl: String? = System.getenv("OPTIO_TEST_API_URL")?.trimEnd('/')
    private val token: String = System.getenv("OPTIO_TEST_API_TOKEN") ?: "dev"

    @Test
    fun theDashboardLoadsFromTheSeededServer() = runBlocking<Unit> {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val api = ApiClient(baseUrl, token)
        val vm = OverviewViewModel(api)
        vm.refresh()
        with(vm.dashboard.value) {
            assertNull(error, "stats answered")
            assertTrue((taskStats?.total ?: 0) > 0, "the seed has tasks")
            assertFalse(isFirstRun)
            assertEquals(5, recentTasks.size)
            assertTrue(attentionTasks.all { it.state == "needs_attention" } && attentionTasks.isNotEmpty(), "the seed has a task needing attention")
            assertTrue((repoCount ?: 0) >= 2)
            // Auth-disabled dev servers let everyone see the (fake) cluster.
            assertTrue(clusterForbidden || cluster?.nodes?.isNotEmpty() == true)
            assertTrue(localHosts.isNotEmpty() && localTerminals.isNotEmpty(), "the seed paired a laptop")
        }
        val rows = WorkFeed.collect(api.workFeedSources())
        assertTrue(rows.isNotEmpty())
    }

    @Test
    fun theSeededServerAsAnotherServersGlance() = runBlocking<Unit> {
        assumeTrue("OPTIO_TEST_API_URL not set", baseUrl != null)
        val glance = ServerGlances.load(OverviewSeed.studio, ServerGlances.withGlanceTimeout(ApiClient(baseUrl, token)))
        assertEquals(ServerGlance.State.ONLINE, glance.state)
        assertNotNull(glance.asOf)
        assertTrue(glance.needsYou >= 1, "its task needing attention")
        assertTrue(glance.hostsTotal >= 1, "the snapshot's hosts")

        // Nothing answers under a wrong base path (404s, not 401s): unreachable, not "token rejected".
        val wrongPath = ServerGlances.load(OverviewSeed.studio, ServerGlances.withGlanceTimeout(ApiClient("$baseUrl/nope", token)))
        assertEquals(ServerGlance.State.UNREACHABLE, wrongPath.state)
    }
}
