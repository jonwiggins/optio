package dev.optio.feature.overview

import androidx.lifecycle.ViewModel
import androidx.lifecycle.viewModelScope
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalHostState
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.WsEvent
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedModel
import dev.optio.core.workfeed.workFeedSources
import java.time.Clock
import java.time.Instant
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock

/** One sample of node metrics, taken on every dashboard refresh (web `MetricsHistoryPoint`). */
internal data class MetricsSample(
    val time: Instant,
    val cpuPercent: Double?,
    val memoryPercent: Double?,
    val pods: Int,
    val agents: Int,
)

/**
 * What the Overview's dashboard shows (iOS `OverviewModel`): task stats, recent and waiting tasks,
 * repos, the cluster (and its metrics history), and Optio Local's hosts and terminals.
 */
internal data class OverviewDashboard(
    val taskStats: DashTaskStats? = null,
    val recentTasks: List<DashRecentTask> = emptyList(),
    val attentionTasks: List<DashRecentTask> = emptyList(),
    val repoCount: Int? = null,
    val cluster: ClusterOverview? = null,
    /** `/api/cluster/overview` answered 403 (viewer / member role). */
    val clusterForbidden: Boolean = false,
    val metricsHistory: List<MetricsSample> = emptyList(),
    val localHosts: List<LocalHost> = emptyList(),
    val localTerminals: List<LocalTerminal> = emptyList(),
    /** True until the first refresh finishes. */
    val loading: Boolean = true,
    /** The latest stats failure (the Overview's error row). */
    val error: Throwable? = null,
    val lastRefreshed: Instant? = null,
) {
    val totalRecentCost: Double
        get() = recentTasks.sumOf { it.cost }

    /** A paired machine with a terminal open counts as "started", even with zero repo tasks. */
    val isFirstRun: Boolean
        get() = (taskStats?.total ?: 0) == 0 && localTerminals.isEmpty()

    val hasLocal: Boolean
        get() = localHosts.isNotEmpty() || localTerminals.isNotEmpty()

    val localHostName: Map<String, String>
        get() = localHosts.associate { it.id to it.name }

    val localHostsOnline: Int
        get() = localHosts.count { it.state == LocalHostState.ONLINE }

    /** Terminals waiting on the human, the one kept waiting longest first. */
    val localNeedsYou: List<LocalTerminal>
        get() = localTerminals.filter(LocalPresentation::waitsOnYou).sortedBy(LocalPresentation::activity)
}

/**
 * The Overview (iOS `OverviewModel` + the board's `WorkFeedModel`, web `use-dashboard-data.ts`):
 * the dashboard refreshed every [DASHBOARD_INTERVAL] while on screen, and the Work feed for the
 * board (polled and refreshed on `/ws/events`). The usage limits come from core:ui's shared
 * `UsageStore`.
 *
 * [feedLoad] and [clock] are seams for tests; the app passes the session's client and a loader for
 * the other servers that uses each one's own token.
 */
internal class OverviewViewModel(
    private val api: ApiClient,
    feedLoad: suspend () -> WorkFeed.Sources = { api.workFeedSources() },
    private val events: Flow<WsEvent>? = null,
    /** The other paired servers' counts (the screen refreshes them while it shows them). */
    val otherServers: OtherServersModel = OtherServersModel { ServerGlance(it) },
    private val clock: Clock = Clock.systemUTC(),
) : ViewModel() {
    private val feedModel = WorkFeedModel(load = feedLoad, scope = viewModelScope, clock = clock)

    /** The Work feed behind the board. */
    val feed: StateFlow<WorkFeedModel.State> = feedModel.state

    private val _dashboard = MutableStateFlow(OverviewDashboard())
    val dashboard: StateFlow<OverviewDashboard> = _dashboard.asStateFlow()

    private val refreshLock = Mutex()
    private var pollJob: Job? = null

    /** The Overview appeared: refresh the dashboard now and every 10 s, and start the feed. */
    fun start() {
        if (pollJob?.isActive != true) {
            pollJob = viewModelScope.launch {
                while (isActive) {
                    refresh()
                    delay(DASHBOARD_INTERVAL)
                }
            }
        }
        feedModel.start(events = events)
    }

    /** The Overview went away (another tab, a detail on top, the app in the background). */
    fun stop() {
        pollJob?.cancel()
        pollJob = null
        feedModel.stop()
    }

    /** Refetches the Work feed now (the board's Retry). */
    suspend fun refreshFeed() = feedModel.refresh()

    /**
     * Refetches the dashboard: stats (whose failure is the Overview's error), recent and waiting
     * tasks, repos, hosts and terminals (whose failures keep the last values), and the cluster
     * (403 → [OverviewDashboard.clusterForbidden]; other failures keep the last one). Every cluster
     * answer with a node adds a metrics sample (at most [MAX_HISTORY]). Refreshes don't overlap.
     */
    suspend fun refresh() = refreshLock.withLock {
        coroutineScope {
            val stats = async { attempt { api.dashTaskStats() } }
            val recent = async { attempt { api.recentTasks(limit = 5) } }
            val attention = async { attempt { api.attentionTasks() } }
            val repos = async { attempt { api.repoCount() } }
            val hosts = async { attempt { api.overviewLocalHosts() } }
            val terminals = async { attempt { api.overviewLocalTerminals() } }
            val cluster = async { attempt { api.clusterOverview() } }

            val statsResult = stats.await()
            val clusterResult = cluster.await()
            val forbidden = (clusterResult.exceptionOrNull() as? ApiError)?.status == 403
            val recentResult = recent.await().getOrNull()
            val attentionResult = attention.await().getOrNull()
            val reposResult = repos.await().getOrNull()
            val hostsResult = hosts.await().getOrNull()
            val terminalsResult = terminals.await().getOrNull()
            val now = clock.instant()

            _dashboard.update { d ->
                val newCluster = clusterResult.getOrNull()
                val node = newCluster?.nodes?.firstOrNull()
                val history = if (newCluster != null && node != null) {
                    (
                        d.metricsHistory + MetricsSample(
                            time = now,
                            cpuPercent = node.cpuUsedPercent,
                            memoryPercent = node.memoryPercent?.toDouble(),
                            pods = newCluster.summary.totalPods,
                            agents = newCluster.summary.agentPods,
                        )
                        ).takeLast(MAX_HISTORY)
                } else {
                    d.metricsHistory
                }
                d.copy(
                    taskStats = statsResult.getOrNull() ?: d.taskStats,
                    error = statsResult.exceptionOrNull(),
                    recentTasks = recentResult ?: d.recentTasks,
                    attentionTasks = attentionResult ?: d.attentionTasks,
                    repoCount = reposResult ?: d.repoCount,
                    localHosts = hostsResult ?: d.localHosts,
                    localTerminals = terminalsResult ?: d.localTerminals,
                    cluster = newCluster ?: d.cluster,
                    clusterForbidden = forbidden,
                    metricsHistory = history,
                    loading = false,
                    lastRefreshed = now,
                )
            }
        }
    }

    /** The header's refresh and pull-to-refresh: the dashboard and the board together. */
    suspend fun refreshAll() = coroutineScope {
        val dash = async { refresh() }
        val rows = async { feedModel.refresh() }
        dash.await()
        rows.await()
    }

    private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
        Result.success(block())
    } catch (e: CancellationException) {
        throw e
    } catch (e: Exception) {
        Result.failure(e)
    }

    companion object {
        /** The dashboard's poll (iOS / web: every 10 s). */
        val DASHBOARD_INTERVAL: Duration = 10.seconds

        /** Ten minutes of 10 s samples. */
        const val MAX_HISTORY = 60
    }
}
