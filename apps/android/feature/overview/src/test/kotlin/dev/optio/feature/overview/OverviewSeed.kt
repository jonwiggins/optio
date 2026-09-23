package dev.optio.feature.overview

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.FakeResponse
import dev.optio.core.testing.Fixtures
import dev.optio.core.ui.hub.LocalHubController
import dev.optio.core.ui.hub.rememberHubController
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedEndpoints
import dev.optio.core.workfeed.WorkFeedModel
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject

/**
 * The DevLab seed as the private test API answered the Overview's endpoints (captured into
 * `src/test/resources/fixtures/overview-*.json` and the feed's `work-*.json`).
 */
internal object OverviewSeed {
    /** A few minutes after the seed ran. */
    val clock: Clock = Clock.fixed(Instant.parse("2026-09-23T00:52:00Z"), ZoneOffset.UTC)

    @Serializable
    private data class Stats(val stats: DashTaskStats)

    @Serializable
    private data class Tasks(val tasks: List<DashRecentTask>)

    @Serializable
    private data class Hosts(val hosts: List<LocalHost>)

    @Serializable
    private data class Terminals(val terminals: List<LocalTerminal>)

    @Serializable
    private data class Unified(val tasks: List<WorkFeed.UnifiedRow>)

    @Serializable
    private data class FeedTerminals(val terminals: List<WorkFeed.TerminalRow>)

    @Serializable
    private data class Blueprints(val blueprints: List<WorkFeed.BlueprintRow>)

    @Serializable
    private data class Sessions(val sessions: List<WorkFeed.PodSessionRow>)

    @Serializable
    private data class Agents(val agents: List<WorkFeed.AgentRow>)

    @Serializable
    private data class FeedHosts(val hosts: List<WorkFeed.HostRow>)

    val feedSources: WorkFeed.Sources by lazy {
        WorkFeed.Sources(
            unified = Fixtures.decode<Unified>("work-tasks-unified.json").tasks,
            localTerminals = Fixtures.decode<FeedTerminals>("work-local-terminals.json").terminals,
            localBlueprints = Fixtures.decode<Blueprints>("work-local-blueprints.json").blueprints,
            podSessions = Fixtures.decode<Sessions>("work-sessions.json").sessions,
            agents = Fixtures.decode<Agents>("work-persistent-agents.json").agents,
            hosts = Fixtures.decode<FeedHosts>("work-local-hosts.json").hosts,
        )
    }

    fun feed(): WorkFeedModel.State = WorkFeedModel.State(rows = WorkFeed.collect(feedSources), loading = false, lastRefreshed = clock.instant())

    /** The dashboard once the seed has loaded, with a few metrics samples. */
    fun dashboard(): OverviewDashboard {
        val cluster = Fixtures.decode<ClusterOverview>("overview-cluster.json")
        return OverviewDashboard(
            taskStats = Fixtures.decode<Stats>("overview-tasks-stats.json").stats,
            recentTasks = Fixtures.decode<Tasks>("overview-tasks-recent.json").tasks,
            attentionTasks = Fixtures.decode<Tasks>("overview-tasks-attention.json").tasks,
            repoCount = 2,
            cluster = cluster,
            metricsHistory = (0 until 18).map { i ->
                MetricsSample(
                    time = clock.instant().minusSeconds((18 - i) * 10L),
                    cpuPercent = 18.0 + (i % 5) * 3 + (if (i > 12) 9 else 0),
                    memoryPercent = 27.0 + i / 3,
                    pods = 5 + (i % 7) / 3,
                    agents = 2,
                )
            },
            localHosts = Fixtures.decode<Hosts>("overview-local-hosts.json").hosts,
            localTerminals = Fixtures.decode<Terminals>("overview-local-terminals.json").terminals,
            loading = false,
            lastRefreshed = clock.instant(),
        )
    }

    /** The recorded agent session, back in a live state waiting on you (the seed's are finished). */
    fun waitingTerminals(): List<LocalTerminal> {
        val recorded = Fixtures.decode<Terminals>("overview-local-terminals.json").terminals
        val agent = recorded.first { it.title == "Fix flaky tests" }
        return listOf(
            agent.copy(id = "waiting-1", state = LocalTerminalState.RUNNING, attentionReason = "stop", lastActivityAt = "2026-09-23T00:40:00Z"),
            agent.copy(
                id = "waiting-2",
                title = "Refactor the settings screen",
                state = LocalTerminalState.RUNNING,
                attentionReason = "quiet",
                lastActivityAt = "2026-09-23T00:47:00Z",
            ),
        )
    }

    val laptop = ServerProfile(id = "dev-server", name = "Laptop", url = "http://10.0.2.2:4962", color = ServerColor.SLATE)
    val studio = ServerProfile(id = "dev-server_2", name = "Studio", url = "http://studio.tailnet.ts.net:30400", color = ServerColor.BLUE)
    val prod = ServerProfile(id = "dev-server_3", name = "Prod", url = "https://optio.example.com", color = ServerColor.ROSE)
    val attic = ServerProfile(id = "dev-server_4", name = "Attic", url = "http://attic.tailnet.ts.net:30400", color = ServerColor.AMBER)

    /** Serves every endpoint the Overview reads on [server]. */
    fun serve(server: FakeOptioServer) {
        server.fixture("/api/tasks/stats", "overview-tasks-stats.json")
        server.get("/api/tasks") { req ->
            when {
                req.queryParam("state") == "needs_attention" -> FakeResponse.fixture("overview-tasks-attention.json")
                req.queryParam("type") == "all" -> FakeResponse.fixture("work-tasks-unified.json")
                else -> FakeResponse.fixture("overview-tasks-recent.json")
            }
        }
        server.fixture("/api/repos", "overview-repos.json")
        server.fixture("/api/cluster/overview", "overview-cluster.json")
        server.fixture("/api/local/hosts", "overview-local-hosts.json")
        server.fixture("/api/local/terminals", "overview-local-terminals.json")
        server.fixture(WorkFeedEndpoints.LOCAL_BLUEPRINTS, "work-local-blueprints.json")
        server.fixture(WorkFeedEndpoints.POD_SESSIONS, "work-sessions.json")
        server.fixture(WorkFeedEndpoints.AGENTS, "work-persistent-agents.json")
    }

    /** The Overview hub's chrome as `:app`'s `HubScreen` draws it (title + the section's actions). */
    @Composable
    fun Hub(
        navigator: Navigator = Navigator.None,
        content: @Composable (PaddingValues) -> Unit,
    ) {
        val controller = rememberHubController()
        CompositionLocalProvider(LocalNavigator provides navigator) {
            Scaffold(
                topBar = {
                    Column { TopAppBar(title = { Text("Overview") }, actions = { controller.actions?.invoke(this) }) }
                },
            ) { padding ->
                CompositionLocalProvider(LocalHubController provides controller) { content(padding) }
            }
        }
    }

    /** A JSON object from a fixture, for tweaking. */
    fun json(name: String): JsonObject = Fixtures.json(name).jsonObject
}
