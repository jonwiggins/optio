package dev.optio.feature.work

import dev.optio.core.testing.FakeOptioServer
import dev.optio.core.testing.Fixtures
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedEndpoints
import dev.optio.core.workfeed.WorkFeedModel
import dev.optio.core.workfeed.WorkRow
import java.time.Clock
import java.time.Instant
import java.time.ZoneOffset
import kotlinx.serialization.Serializable

/**
 * The DevLab seed as the private test API answered the six feed endpoints (captured into
 * `src/test/resources/fixtures/work-*.json`, the same files as `:core:workfeed`'s tests).
 */
object WorkSeed {
    /** A few minutes after the seed ran, so relative times read "6 min. ago". */
    val clock: Clock = Clock.fixed(Instant.parse("2026-09-23T00:52:00Z"), ZoneOffset.UTC)

    @Serializable
    private data class Unified(val tasks: List<WorkFeed.UnifiedRow>)

    @Serializable
    private data class Terminals(val terminals: List<WorkFeed.TerminalRow>)

    @Serializable
    private data class Blueprints(val blueprints: List<WorkFeed.BlueprintRow>)

    @Serializable
    private data class Sessions(val sessions: List<WorkFeed.PodSessionRow>)

    @Serializable
    private data class Agents(val agents: List<WorkFeed.AgentRow>)

    @Serializable
    private data class Hosts(val hosts: List<WorkFeed.HostRow>)

    val sources: WorkFeed.Sources by lazy {
        WorkFeed.Sources(
            unified = Fixtures.decode<Unified>("work-tasks-unified.json").tasks,
            localTerminals = Fixtures.decode<Terminals>("work-local-terminals.json").terminals,
            localBlueprints = Fixtures.decode<Blueprints>("work-local-blueprints.json").blueprints,
            podSessions = Fixtures.decode<Sessions>("work-sessions.json").sessions,
            agents = Fixtures.decode<Agents>("work-persistent-agents.json").agents,
            hosts = Fixtures.decode<Hosts>("work-local-hosts.json").hosts,
        )
    }

    val rows: List<WorkRow> by lazy { WorkFeed.collect(sources) }

    /** The feed state a screen shows once the seed has loaded. */
    fun loaded(): WorkFeedModel.State = WorkFeedModel.State(rows = rows, loading = false, lastRefreshed = clock.instant())

    /** Serves the seed on [server]'s six feed endpoints. */
    fun serve(server: FakeOptioServer) {
        server.fixture(WorkFeedEndpoints.UNIFIED, "work-tasks-unified.json")
        server.fixture(WorkFeedEndpoints.LOCAL_TERMINALS, "work-local-terminals.json")
        server.fixture(WorkFeedEndpoints.LOCAL_BLUEPRINTS, "work-local-blueprints.json")
        server.fixture(WorkFeedEndpoints.POD_SESSIONS, "work-sessions.json")
        server.fixture(WorkFeedEndpoints.AGENTS, "work-persistent-agents.json")
        server.fixture(WorkFeedEndpoints.LOCAL_HOSTS, "work-local-hosts.json")
    }
}
