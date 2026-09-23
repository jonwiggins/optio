package dev.optio.core.testing

import dev.optio.core.model.LocalHost
import dev.optio.core.ui.usage.AuthFailures
import dev.optio.core.ui.usage.ClaudeUsageData
import dev.optio.core.ui.usage.DashAuthStatus
import dev.optio.core.ui.usage.UsageModelWindow
import dev.optio.core.ui.usage.UsageSource
import dev.optio.core.ui.usage.UsageStore
import dev.optio.core.ui.usage.UsageWindow
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking

/**
 * Sample usage data and ready-filled [UsageStore]s for screenshots of anything that shows the
 * limits panel, the usage pill or the token banners (provide the store as `LocalUsageStore`).
 */
object UsageSamples {
    /** Claude usage: 5h / 7d windows and per-model weekly caps, resetting relative to [Samples.NOW]. */
    fun usage(
        fiveHour: Double? = 31.0,
        sevenDay: Double? = 52.0,
        models: List<Pair<String, Double>> = listOf("Fable" to 88.0),
        stale: Boolean = false,
        error: String? = if (stale) "upstream 429" else null,
        asOf: Instant = Samples.ago(if (stale) 45 else 2),
    ) = ClaudeUsageData(
        available = true,
        error = error,
        fiveHour = fiveHour?.let { UsageWindow(it, Samples.NOW.plus(Duration.ofMinutes(90)).toString()) },
        sevenDay = sevenDay?.let { UsageWindow(it, Samples.NOW.plus(Duration.ofHours(76)).toString()) },
        sevenDayModels = models.map { (model, used) -> UsageModelWindow(model, used, Samples.NOW.plus(Duration.ofHours(88)).toString()) },
        asOf = asOf.toString(),
        stale = stale.takeIf { it },
        authFailures = AuthFailures(claude = false, github = false),
    )

    /** Both tokens failing (the red banners). */
    fun expired() = ClaudeUsageData(
        available = false,
        error = "OAuth token has expired — please paste a new one",
        hasRecentAuthFailure = true,
        authFailures = AuthFailures(claude = true, github = true),
    )

    /** A [UsageSource] answering from memory. */
    class StaticSource(
        private val usage: ClaudeUsageData?,
        private val hosts: List<LocalHost>,
        private val status: DashAuthStatus = DashAuthStatus(),
    ) : UsageSource {
        override suspend fun accountUsage(fresh: Boolean): ClaudeUsageData = usage ?: error("no usage")

        override suspend fun authStatus(): DashAuthStatus = status

        override suspend fun localHosts(): List<LocalHost> = hosts
    }

    /**
     * A store already holding [usage] and [hosts] (fetched at [Samples.NOW]); [refreshed] also
     * runs a manual refresh so the header reads "updated just now".
     */
    fun store(
        usage: ClaudeUsageData? = usage(),
        hosts: List<LocalHost> = listOf(Samples.localHost(codex = Samples.codexLimits())),
        refreshed: Boolean = false,
    ): UsageStore {
        val store = UsageStore(scope = CoroutineScope(Dispatchers.Unconfined), clock = { Samples.NOW })
        store.bind(StaticSource(usage, hosts), key = "samples")
        runBlocking {
            if (refreshed) store.refreshFresh() else store.refresh()
        }
        return store
    }
}
