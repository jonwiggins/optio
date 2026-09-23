package dev.optio.core.ui.usage

import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.network.ApiError
import java.time.Instant
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.test.TestScope
import kotlinx.coroutines.test.advanceTimeBy
import kotlinx.coroutines.test.runCurrent
import kotlinx.coroutines.test.runTest

/** `UsageStore` timing on virtual time: polling, staleness, pacing, sharing, server switches. */
@OptIn(ExperimentalCoroutinesApi::class)
class UsageStoreTest {
    private class FakeSource(
        var usage: ClaudeUsageData = ClaudeUsageData(available = true, fiveHour = UsageWindow(31.0, null), sevenDay = UsageWindow(52.0, null)),
        var status: DashAuthStatus = DashAuthStatus(),
        var hosts: List<LocalHost> = emptyList(),
    ) : UsageSource {
        var usageError: Exception? = null
        var hostsError: Exception? = null
        var latencyMs = 0L
        val usageCalls = mutableListOf<Boolean>()
        var statusCalls = 0
        var hostCalls = 0

        override suspend fun accountUsage(fresh: Boolean): ClaudeUsageData {
            usageCalls += fresh
            if (latencyMs > 0) delay(latencyMs)
            usageError?.let { throw it }
            return usage
        }

        override suspend fun authStatus(): DashAuthStatus {
            statusCalls++
            return status
        }

        override suspend fun localHosts(): List<LocalHost> {
            hostCalls++
            hostsError?.let { throw it }
            return hosts
        }
    }

    private fun host(id: String) = LocalHost(
        id = id, name = id, hostname = id, platform = "darwin", dirs = emptyList(),
        state = LocalHostState.ONLINE, createdAt = "2026-01-01T00:00:00Z", updatedAt = "2026-01-01T00:00:00Z",
    )

    private fun TestScope.newStore(): UsageStore =
        UsageStore(scope = backgroundScope, clock = { Instant.ofEpochMilli(testScheduler.currentTime) })

    @Test
    fun observeRefreshesNowThenEveryMinuteUntilCancelled() = runTest {
        val source = FakeSource()
        val store = newStore()
        store.bind(source, key = "a")
        val viewer = launch { store.observe() }
        runCurrent()
        assertEquals(1, source.usageCalls.size)
        assertEquals(1, store.viewerCount)
        assertEquals(31.0, store.usage?.fiveHour?.utilization)
        assertEquals(1, source.hostCalls)

        advanceTimeBy(59_999)
        runCurrent()
        assertEquals(1, source.usageCalls.size)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(2, source.usageCalls.size)
        advanceTimeBy(60_000)
        runCurrent()
        assertEquals(3, source.usageCalls.size)
        assertEquals(listOf(false, false, false), source.usageCalls)

        viewer.cancel()
        runCurrent()
        assertEquals(0, store.viewerCount)
        advanceTimeBy(300_000)
        runCurrent()
        assertEquals(3, source.usageCalls.size)
    }

    @Test
    fun aViewerAppearingWithin30sReusesTheCache() = runTest {
        val source = FakeSource()
        val store = newStore()
        store.bind(source, key = "a")
        store.refresh()
        assertEquals(1, source.usageCalls.size)

        advanceTimeBy(20_000)
        store.refreshIfStale()
        assertEquals(1, source.usageCalls.size)

        advanceTimeBy(11_000)
        store.refreshIfStale()
        assertEquals(2, source.usageCalls.size)
    }

    @Test
    fun twoViewersShareTheirPolling() = runTest {
        val source = FakeSource()
        val store = newStore()
        store.bind(source, key = "a")
        val first = launch { store.observe() }
        runCurrent()
        advanceTimeBy(10_000)
        val second = launch { store.observe() }
        runCurrent()
        // The second viewer found the cache 10 s old and reused it.
        assertEquals(1, source.usageCalls.size)
        assertEquals(2, store.viewerCount)
        first.cancel()
        second.cancel()
    }

    @Test
    fun concurrentCallersAwaitOneRequest() = runTest {
        val source = FakeSource().apply { latencyMs = 1_000 }
        val store = newStore()
        store.bind(source, key = "a")
        val a = launch { store.refresh() }
        val b = launch { store.refresh() }
        runCurrent()
        assertEquals(1, source.usageCalls.size)
        advanceTimeBy(1_001)
        runCurrent()
        assertTrue(a.isCompleted && b.isCompleted)
        assertEquals(1, source.usageCalls.size)
        assertEquals(31.0, store.usage?.fiveHour?.utilization)
    }

    @Test
    fun freshRefreshIsPacedAndHoldsTheSpinner() = runTest {
        val source = FakeSource()
        val store = newStore()
        store.bind(source, key = "a")

        var result: Boolean? = null
        launch { result = store.refreshFresh() }
        runCurrent()
        assertEquals(listOf(true), source.usageCalls)
        assertTrue(store.refreshing, "spinner holds while the 400 ms floor runs")
        assertNull(store.refreshedAt)
        advanceTimeBy(399)
        runCurrent()
        assertTrue(store.refreshing)
        advanceTimeBy(2)
        runCurrent()
        assertEquals(true, result)
        assertFalse(store.refreshing)
        assertEquals(Instant.ofEpochMilli(400), store.refreshedAt)

        advanceTimeBy(10_000)
        assertFalse(store.refreshFresh(), "within 15 s of the last one")
        assertEquals(1, source.usageCalls.size)

        advanceTimeBy(5_000)
        launch { assertTrue(store.refreshFresh()) }
        advanceTimeBy(500)
        runCurrent()
        assertEquals(listOf(true, true), source.usageCalls)
    }

    @Test
    fun aFailedFreshRefreshReportsItsError() = runTest {
        val source = FakeSource().apply { usageError = ApiError(503, "Service Unavailable") }
        val store = newStore()
        store.bind(source, key = "a")
        launch { store.refreshFresh() }
        advanceTimeBy(500)
        runCurrent()
        assertEquals("Couldn't load usage — the server hit an error.", store.refreshError)
        assertNull(store.refreshedAt)
        assertFalse(store.refreshing)
        // A plain (non-fresh) failure never sets refreshError.
        val quiet = newStore().apply { bind(FakeSource().apply { usageError = ApiError(503, "x") }, key = "b") }
        quiet.refresh()
        assertNull(quiet.refreshError)
    }

    @Test
    fun unavailableWithoutErrorIsCrossCheckedForAnExpiredToken() = runTest {
        val source = FakeSource(
            usage = ClaudeUsageData(available = false),
            status = DashAuthStatus(AuthSubscriptionStatus(available = false, expired = true)),
        )
        val store = newStore()
        store.bind(source, key = "a")
        store.refresh()
        assertEquals(1, source.statusCalls)
        assertEquals("OAuth token has expired", store.usage?.error)
        assertTrue(store.usage?.claudeAuthFailed == true)
        assertTrue(store.claudeBuckets.isEmpty())
    }

    @Test
    fun aFailedCallIsCrossCheckedToo() = runTest {
        val source = FakeSource(status = DashAuthStatus(AuthSubscriptionStatus(expired = true))).apply {
            usageError = ApiError(0, "Could not connect to the server.")
        }
        val store = newStore()
        store.bind(source, key = "a")
        store.refresh()
        assertEquals("OAuth token has expired", store.usage?.error)
    }

    @Test
    fun unavailableWithAReasonSkipsTheStatusCall() = runTest {
        val source = FakeSource(usage = ClaudeUsageData(available = false, error = "No Claude subscription credentials found on this host"))
        val store = newStore()
        store.bind(source, key = "a")
        store.refresh()
        assertEquals(0, source.statusCalls)
        assertFalse(store.usage?.claudeAuthFailed == true)
        assertTrue(store.providerLimits.isEmpty())
    }

    @Test
    fun aFailedHostsCallKeepsThePreviousHosts() = runTest {
        val source = FakeSource(hosts = listOf(host("a"), host("b")))
        val store = newStore()
        store.bind(source, key = "a")
        store.refresh()
        assertEquals(2, store.hosts.size)
        source.hostsError = ApiError(500, "boom")
        source.usage = source.usage.copy(fiveHour = UsageWindow(40.0, null))
        advanceTimeBy(31_000)
        store.refreshIfStale()
        assertEquals(2, store.hosts.size)
        assertEquals(40.0, store.usage?.fiveHour?.utilization)
    }

    @Test
    fun bindingAnotherServerDropsTheCacheAndLateResults() = runTest {
        val a = FakeSource().apply { latencyMs = 1_000 }
        val b = FakeSource(usage = ClaudeUsageData(available = true, fiveHour = UsageWindow(5.0, null)))
        val store = newStore()
        store.bind(a, key = "server-a")
        launch { store.refresh() }
        runCurrent()
        advanceTimeBy(500)
        store.bind(b, key = "server-b")
        advanceTimeBy(600)
        runCurrent()
        assertNull(store.usage, "server A's late answer must not land on server B")
        assertNull(store.lastFetched)

        store.refresh()
        assertEquals(5.0, store.usage?.fiveHour?.utilization)
        // Re-binding the same key keeps the cache.
        store.bind(b, key = "server-b")
        assertEquals(5.0, store.usage?.fiveHour?.utilization)
    }

    @Test
    fun derivedProvidersAndBuckets() = runTest {
        val source = FakeSource(
            usage = ClaudeUsageData(
                available = true,
                fiveHour = UsageWindow(31.0, null),
                sevenDayModels = listOf(UsageModelWindow("Fable", 88.0)),
            ),
        )
        val store = newStore()
        assertTrue(store.claudeBuckets.isEmpty())
        store.bind(source, key = "a")
        store.refresh()
        assertEquals(listOf("5h", "7d Fable"), store.claudeBuckets.map { it.label })
        assertEquals(listOf(ProviderLimits.Key.CLAUDE), store.providerLimits.map { it.key })
    }
}
