package dev.optio.core.ui.usage

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.LocalHostState
import dev.optio.core.network.ApiClient
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeOptioServerRule
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.log.TaskLogsEnvelope
import dev.optio.core.ui.log.asEntries
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.test.runTest
import org.junit.Assume.assumeTrue
import org.junit.Rule

/**
 * The usage endpoints through a real `ApiClient` against [FakeOptioServer], with fixtures captured
 * from the private test API; the store's server-switch handling on a re-pointed client; and (when
 * `OPTIO_TEST_API_URL` is set) the same calls against a live private test API.
 */
class UsageApiTest {
    @get:Rule
    val rule = FakeOptioServerRule()

    private val server get() = rule.server

    private val now = Instant.parse("2026-09-22T16:40:00Z")

    @Test
    fun accountUsageDecodesAndOnlyFreshSendsTheFlag() = runTest {
        server.fixture("/api/auth/usage", "auth-usage.json")
        val api = server.client()

        val usage = api.accountUsage()
        assertTrue(usage.available)
        assertEquals(listOf("5h", "7d", "7d Fable"), UsageLimits.claudeBuckets(usage).map { it.label })
        assertEquals(88.0, usage.sevenDayModels?.single()?.utilization)
        assertNull(server.lastRequest("GET", "/api/auth/usage")!!.queryParam("fresh"))
        assertEquals("Bearer ${FakeOptioServer.TEST_TOKEN}", server.lastRequest()!!.header("Authorization"))

        api.accountUsage(fresh = true)
        assertEquals("1", server.lastRequest("GET", "/api/auth/usage")!!.queryParam("fresh"))
    }

    @Test
    fun capturedAndConstructedFixturesDecode() = runTest {
        val api = server.client()
        server.fixture("/api/auth/usage", "auth-usage-unavailable.json")
        val unavailable = api.accountUsage()
        assertFalse(unavailable.available)
        assertFalse(unavailable.claudeAuthFailed)
        assertEquals("No Claude subscription credentials found on this host", unavailable.error)

        server.fixture("/api/auth/usage", "auth-usage-expired.json")
        val expired = api.accountUsage()
        assertTrue(expired.claudeAuthFailed)
        assertTrue(expired.githubAuthFailed)

        server.fixture("/api/auth/usage", "auth-usage-stale.json")
        assertEquals(true, api.accountUsage().stale)

        server.fixture("/api/auth/status", "auth-status-expired.json")
        assertEquals(true, api.dashAuthStatus().subscription?.expired)
        server.fixture("/api/auth/status", "auth-status-unavailable.json")
        assertEquals(false, api.dashAuthStatus().subscription?.available)

        server.fixture("/api/local/hosts", "local-hosts-devlab.json")
        val hosts = api.usageLocalHosts()
        assertEquals(LocalHostState.OFFLINE, hosts.single().state)
        assertNull(hosts.single().agentLimits)

        val logs = Fixtures.decode<TaskLogsEnvelope>("task-logs.json").logs.asEntries("t1")
        assertEquals(
            listOf(AgentLogEntry.TypeValue.SYSTEM, AgentLogEntry.TypeValue.TEXT, AgentLogEntry.TypeValue.TEXT, AgentLogEntry.TypeValue.INFO),
            logs.map { it.type },
        )
    }

    @Test
    fun storeOverTheApiFoldsClaudeAndTheFreshestCodexSnapshot() = runTest {
        server.fixture("/api/auth/usage", "auth-usage.json")
        server.fixture("/api/local/hosts", "local-hosts.json")
        val store = UsageStore(scope = backgroundScope, clock = { now })
        store.bind(server.client())
        store.refresh()
        val providers = store.providerLimits
        assertEquals(listOf(ProviderLimits.Key.CLAUDE, ProviderLimits.Key.CODEX), providers.map { it.key })
        val codex = providers[1]
        assertEquals("pro", codex.planType, "the online host's snapshot is the freshest")
        assertEquals(listOf("5h", "7d"), codex.windows.map { it.label })
        assertEquals(0, server.count("GET", "/api/auth/status"), "available usage needs no status check")
    }

    @Test
    fun anUnavailableAnswerIsCheckedAgainstAuthStatus() = runTest {
        server.json("/api/auth/usage", """{"usage":{"available":false}}""")
        server.fixture("/api/auth/status", "auth-status-expired.json")
        server.fixture("/api/local/hosts", "local-hosts-devlab.json")
        val store = UsageStore(scope = backgroundScope, clock = { now })
        store.bind(server.client())
        store.refresh()
        assertEquals(1, server.count("GET", "/api/auth/status"))
        assertTrue(store.usage!!.claudeAuthFailed)
    }

    @Test
    fun aClientRepointedAtAnotherServerDropsTheCache() = runTest {
        val other = FakeOptioServer().start()
        try {
            server.fixture("/api/auth/usage", "auth-usage.json")
            server.fixture("/api/local/hosts", "local-hosts.json")
            other.json("/api/auth/usage", """{"usage":{"available":true,"fiveHour":{"utilization":3}}}""")
            other.json("/api/local/hosts", """{"hosts":[]}""")

            val api = ApiClient(server.baseUrl, "token-a")
            val store = UsageStore(scope = backgroundScope, clock = { now })
            store.bind(api)
            store.refresh()
            assertEquals(31.0, store.usage?.fiveHour?.utilization)

            // SessionStore re-points the one client on a server switch (iOS does the same).
            api.configure(other.baseUrl, "token-b", null)
            store.refreshIfStale()
            assertEquals(3.0, store.usage?.fiveHour?.utilization, "the switch must refetch, not reuse A's cache")
            assertTrue(store.hosts.isEmpty())
            assertEquals("Bearer token-b", other.lastRequest("GET", "/api/auth/usage")!!.header("Authorization"))
        } finally {
            other.close()
        }
    }

    @Test
    fun serverErrorsSurfaceOnlyForManualRefreshes() = runTest {
        server.error("GET", "/api/auth/usage", 429, "Too Many Requests")
        server.on("GET", "/api/local/hosts") { FakeResponse.json("""{"hosts":[]}""") }
        server.fixture("/api/auth/status", "auth-status.json")
        val store = UsageStore(scope = backgroundScope, clock = { now })
        store.bind(server.client())
        store.refresh()
        assertNull(store.refreshError)
        assertNull(store.usage)
        assertNotNull(store.lastFetched)

        store.refresh(fresh = true)
        assertEquals("Slow down — the server is rate limiting. Retrying in a moment.", store.refreshError)
    }

    /** Runs only with `OPTIO_TEST_API_URL` (e.g. `http://127.0.0.1:4972`), against a real API. */
    @Test
    fun liveTestApi() = runTest {
        val url = System.getenv("OPTIO_TEST_API_URL")
        assumeTrue("OPTIO_TEST_API_URL not set", !url.isNullOrBlank())
        val api = ApiClient(url, "dev")
        val usage = api.accountUsage()
        // The test API has no Claude subscription: unavailable with a reason, not an auth failure.
        assertFalse(usage.available)
        assertFalse(usage.claudeAuthFailed)
        assertNotNull(api.dashAuthStatus().subscription)
        val hosts = api.usageLocalHosts()
        assertTrue(hosts.isNotEmpty(), "DevLab seeds the E2E laptop")
        val store = UsageStore(scope = backgroundScope)
        store.bind(api)
        store.refresh()
        assertNotNull(store.lastFetched)
        assertTrue(store.claudeBuckets.isEmpty())
    }
}
