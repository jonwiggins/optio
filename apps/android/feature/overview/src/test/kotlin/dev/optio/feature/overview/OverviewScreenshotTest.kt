package dev.optio.feature.overview

import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.test.hasTestTag
import androidx.compose.ui.test.onNodeWithTag
import androidx.compose.ui.test.performClick
import androidx.compose.ui.test.performScrollToNode
import dev.optio.core.model.AgentLimitWindow
import dev.optio.core.model.LocalHostAgentLimits
import dev.optio.core.model.LocalHostState
import dev.optio.core.network.ApiError
import dev.optio.core.testing.ScreenSize
import dev.optio.core.testing.ScreenScope
import dev.optio.core.testing.ScreenshotTest
import dev.optio.core.testing.UsageSamples
import dev.optio.core.testing.captureScreens
import dev.optio.core.ui.usage.AuthFailures
import dev.optio.core.ui.usage.ClaudeUsageData
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.UsageModelWindow
import dev.optio.core.ui.usage.UsageStore
import dev.optio.core.ui.usage.UsageWindow
import dev.optio.core.workfeed.WorkFeedModel
import java.time.Duration
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.runBlocking
import org.junit.Test

/**
 * The Overview against the DevLab seed, light and dark, inside the hub's chrome
 * (`./gradlew :feature:overview:recordRoborazziDebug` → `build/outputs/roborazzi/Overview_*.png`).
 */
class OverviewScreenshotTest : ScreenshotTest() {
    private val now = OverviewSeed.clock.instant()

    /** Claude live and Codex from the seed laptop's last snapshot, dated around the seed. */
    private fun usageStore(usage: ClaudeUsageData = liveUsage()): UsageStore {
        val host = OverviewSeed.dashboard().localHosts.first().copy(
            state = LocalHostState.ONLINE,
            agentLimits = LocalHostAgentLimits(
                codex = LocalHostAgentLimits.Codex(
                    primary = AgentLimitWindow(42.5, 300.0, now.plus(Duration.ofMinutes(140)).toString()),
                    secondary = AgentLimitWindow(7.0, 10_080.0, now.plus(Duration.ofDays(4)).toString()),
                    planType = "pro",
                    observedAt = now.minus(Duration.ofMinutes(20)).toString(),
                ),
            ),
        )
        val store = UsageStore(scope = CoroutineScope(Dispatchers.Unconfined), clock = { now })
        store.bind(UsageSamples.StaticSource(usage, listOf(host)), key = "overview")
        runBlocking { store.refresh() }
        return store
    }

    private fun liveUsage() = ClaudeUsageData(
        available = true,
        fiveHour = UsageWindow(31.0, now.plus(Duration.ofMinutes(90)).toString()),
        sevenDay = UsageWindow(52.0, now.plus(Duration.ofHours(76)).toString()),
        sevenDayModels = listOf(UsageModelWindow("Fable", 88.0, now.plus(Duration.ofHours(88)).toString())),
        asOf = now.minus(Duration.ofMinutes(2)).toString(),
        authFailures = AuthFailures(claude = false, github = false),
    )

    private val others = listOf(
        ServerGlance(OverviewSeed.studio, ServerGlance.State.ONLINE, running = 3, needsYou = 2, failed = 1, hostsOnline = 1, hostsTotal = 1, asOf = now),
        ServerGlance(OverviewSeed.prod, ServerGlance.State.UNAUTHORIZED),
        ServerGlance(OverviewSeed.attic, ServerGlance.State.UNREACHABLE),
    )

    private val active = ActiveServer(OverviewSeed.laptop, userLabel = "Local Dev", switching = false, serverCount = 4)

    @Composable
    private fun Screen(
        dashboard: OverviewDashboard,
        feed: WorkFeedModel.State = OverviewSeed.feed(),
        otherServers: List<ServerGlance> = others,
        usage: UsageStore? = usageStore(),
    ) {
        CompositionLocalProvider(LocalUsageStore provides usage) {
            OverviewSeed.Hub { padding ->
                OverviewContent(
                    dashboard = dashboard,
                    feed = feed,
                    server = active,
                    otherServers = otherServers,
                    contentPadding = padding,
                    actions = OverviewActions(),
                )
            }
        }
    }

    private fun shot(
        name: String,
        size: ScreenSize = ScreenSize.PHONE,
        interact: ScreenScope.() -> Unit = {},
        content: @Composable () -> Unit,
    ) = captureScreens(name, size = size, clock = OverviewSeed.clock, interact = interact, content = content)

    @Test
    fun seeded() = shot("Overview_seed", ScreenSize.TALL) { Screen(OverviewSeed.dashboard()) }

    @Test
    fun seededBottom() =
        shot("Overview_seedBottom", ScreenSize.TALL, interact = {
            onNodeWithTag("overview-list").performScrollToNode(hasTestTag("other-server-dev-server_4"))
        }) { Screen(OverviewSeed.dashboard()) }

    @Test
    fun needsYou() =
        shot("Overview_needsYou") {
            val seed = OverviewSeed.dashboard()
            Screen(seed.copy(localTerminals = seed.localTerminals + OverviewSeed.waitingTerminals()), usage = null)
        }

    @Test
    fun metrics() =
        shot("Overview_metrics", ScreenSize.TALL, interact = {
            onNodeWithTag("overview-list").performScrollToNode(hasTestTag("cluster-summary"))
            onNodeWithTag("cluster-metrics-toggle").performClick()
            waitForIdle()
            onNodeWithTag("overview-list").performScrollToNode(hasTestTag("cluster-summary"))
        }) { Screen(OverviewSeed.dashboard()) }

    @Test
    fun viewerAndExpiredTokens() =
        shot("Overview_viewer", ScreenSize.TALL, interact = {
            onNodeWithTag("overview-list").performScrollToNode(hasTestTag("cluster-summary"))
        }) {
            Screen(
                OverviewSeed.dashboard().copy(cluster = null, clusterForbidden = true),
                otherServers = emptyList(),
                usage = usageStore(UsageSamples.expired()),
            )
        }

    @Test
    fun loading() =
        shot("Overview_loading") {
            Screen(OverviewDashboard(), feed = WorkFeedModel.State(), otherServers = emptyList(), usage = null)
        }

    @Test
    fun welcome() =
        shot("Overview_welcome") {
            Screen(
                OverviewDashboard(taskStats = DashTaskStats(), repoCount = 0, loading = false),
                feed = WorkFeedModel.State(loading = false),
                otherServers = emptyList(),
                usage = null,
            )
        }

    @Test
    fun unreachable() =
        shot("Overview_error") {
            Screen(
                OverviewDashboard(loading = false, error = ApiError(0, "The server can't be reached.")),
                feed = WorkFeedModel.State(loading = false, error = ApiError(0, "The server can't be reached.")),
                otherServers = emptyList(),
                usage = null,
            )
        }

    @Test
    fun refreshFailedAfterALoad() =
        shot("Overview_staleError") {
            Screen(
                OverviewSeed.dashboard().copy(error = ApiError(502, "Bad gateway")),
                feed = OverviewSeed.feed().copy(error = ApiError(502, "Bad gateway")),
                otherServers = emptyList(),
                usage = null,
            )
        }
}
