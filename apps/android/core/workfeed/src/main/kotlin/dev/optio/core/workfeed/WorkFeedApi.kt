package dev.optio.core.workfeed

import dev.optio.core.network.ApiClient
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable

// The six endpoints the web's `useWorkFeed` fans out to (iOS `APIClient.sessionsFeedSources`).

@Serializable
private data class UnifiedEnvelope(val tasks: List<WorkFeed.UnifiedRow>)

@Serializable
private data class TerminalsEnvelope(val terminals: List<WorkFeed.TerminalRow>)

@Serializable
private data class BlueprintsEnvelope(val blueprints: List<WorkFeed.BlueprintRow>)

@Serializable
private data class PodSessionsEnvelope(val sessions: List<WorkFeed.PodSessionRow>)

@Serializable
private data class AgentsEnvelope(val agents: List<WorkFeed.AgentRow>)

@Serializable
private data class HostsEnvelope(val hosts: List<WorkFeed.HostRow>)

/** The paths [workFeedSources] reads, in fan-out order. */
object WorkFeedEndpoints {
    const val UNIFIED = "/api/tasks"
    const val LOCAL_TERMINALS = "/api/local/terminals"
    const val LOCAL_BLUEPRINTS = "/api/local/blueprints"
    const val POD_SESSIONS = "/api/sessions"
    const val AGENTS = "/api/persistent-agents"
    const val LOCAL_HOSTS = "/api/local/hosts"

    /** `?type=all&limit=200`: every repo task, blueprint and job, like the web. */
    val UNIFIED_QUERY: Map<String, Any?> = mapOf("type" to "all", "limit" to 200)

    /** `?limit=100` for pod sessions, like the web. */
    val POD_SESSIONS_QUERY: Map<String, Any?> = mapOf("limit" to 100)
}

/**
 * Every source of the Work feed, fetched in parallel. A failing endpoint contributes an empty
 * list (the web `settle`s each call) so one broken kind never blanks the whole feed; only when
 * *all six* fail is the unified list's error thrown (iOS parity).
 */
suspend fun ApiClient.workFeedSources(): WorkFeed.Sources = coroutineScope {
    val unified = async { attempt { get<UnifiedEnvelope>(WorkFeedEndpoints.UNIFIED, WorkFeedEndpoints.UNIFIED_QUERY).tasks } }
    val terminals = async { attempt { get<TerminalsEnvelope>(WorkFeedEndpoints.LOCAL_TERMINALS).terminals } }
    val blueprints = async { attempt { get<BlueprintsEnvelope>(WorkFeedEndpoints.LOCAL_BLUEPRINTS).blueprints } }
    val sessions = async { attempt { get<PodSessionsEnvelope>(WorkFeedEndpoints.POD_SESSIONS, WorkFeedEndpoints.POD_SESSIONS_QUERY).sessions } }
    val agents = async { attempt { get<AgentsEnvelope>(WorkFeedEndpoints.AGENTS).agents } }
    val hosts = async { attempt { get<HostsEnvelope>(WorkFeedEndpoints.LOCAL_HOSTS).hosts } }

    val u = unified.await()
    val t = terminals.await()
    val b = blueprints.await()
    val s = sessions.await()
    val a = agents.await()
    val h = hosts.await()
    val unifiedError = u.error
    if (unifiedError != null && listOf(t, b, s, a, h).all { it.error != null }) throw unifiedError
    WorkFeed.Sources(
        unified = u.value.orEmpty(),
        localTerminals = t.value.orEmpty(),
        localBlueprints = b.value.orEmpty(),
        podSessions = s.value.orEmpty(),
        agents = a.value.orEmpty(),
        hosts = h.value.orEmpty(),
    )
}

/** One endpoint's outcome: a value or the error it failed with. */
private class Attempt<T>(val value: T?, val error: Exception?)

private suspend fun <T> attempt(block: suspend () -> T): Attempt<T> = try {
    Attempt(block(), null)
} catch (e: CancellationException) {
    throw e
} catch (e: Exception) {
    Attempt(null, e)
}
