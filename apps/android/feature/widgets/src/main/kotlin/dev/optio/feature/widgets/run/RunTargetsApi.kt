package dev.optio.feature.widgets.run

import dev.optio.core.data.ServerClient
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

// Route-local envelopes: only the fields the pickers need (iOS decodes the same narrow rows).

@Serializable
internal data class BlueprintRow(
    val id: String,
    val name: String,
    val spawnMode: String? = null,
)

@Serializable
internal data class BlueprintsEnvelope(val blueprints: List<BlueprintRow> = emptyList())

@Serializable
internal data class JobRow(
    val id: String,
    val name: String,
    val enabled: Boolean? = null,
)

@Serializable
internal data class JobsEnvelope(val workflows: List<JobRow> = emptyList())

/** This server's Local blueprints as run targets ([serverId] namespaces the ids, [label] names the server). */
internal suspend fun ApiClient.blueprintTargets(
    serverId: String?,
    label: String?,
): List<RunTarget> =
    get<BlueprintsEnvelope>("/api/local/blueprints").blueprints.map {
        RunTarget(RunTarget.makeId(serverId, RunTarget.Kind.LOCAL, it.id), it.name, RunTarget.Kind.LOCAL, it.spawnMode, label)
    }

/** This server's enabled Jobs as run targets. */
internal suspend fun ApiClient.jobTargets(
    serverId: String?,
    label: String?,
): List<RunTarget> =
    get<JobsEnvelope>("/api/jobs").workflows.filter { it.enabled ?: true }.map {
        RunTarget(RunTarget.makeId(serverId, RunTarget.Kind.JOB, it.id), it.name, RunTarget.Kind.JOB, serverName = label)
    }

/**
 * Both lists on every paired server (iOS `RunTargetEntity.fetchAll`): [clients] in their order
 * (active first), blueprints before jobs, each request failing independently (an offline server
 * just contributes nothing). Rows carry the server's short name when more than one is paired.
 */
suspend fun fetchAllRunTargets(clients: List<ServerClient>): List<RunTarget> =
    coroutineScope {
        val multi = clients.size > 1
        clients.map { client ->
            async {
                val label = if (multi) client.server.shortName else null
                val blueprints = async { attempt { client.api.blueprintTargets(client.server.id, label) } }
                val jobs = async { attempt { client.api.jobTargets(client.server.id, label) } }
                blueprints.await().orEmpty() + jobs.await().orEmpty()
            }
        }.awaitAll().flatten()
    }

/** What firing a target on its server did. */
data class FireReceipt(
    /** A Local blueprint held for a manual start (`spawnMode = hold`): the terminal waits in the cockpit. */
    val held: Boolean = false,
    /** The blueprint's machine is offline: the terminal starts when it reconnects. */
    val waitsForHost: Boolean = false,
    /** The spawned terminal's directory leaf, when the server says. */
    val dir: String? = null,
)

/**
 * `POST`s [target]'s fire path on this client (iOS `RunTargetIntent`: an empty JSON body, a 15 s
 * wall clock). Throws [ApiError] (or a timeout) on failure.
 */
internal suspend fun ApiClient.fire(
    target: RunTarget,
    timeout: Duration = FIRE_TIMEOUT,
): FireReceipt {
    val path = target.firePath ?: throw ApiError(0, "Not a blueprint or job: ${target.id}")
    // On IO: the wall clock (not a caller's test clock) bounds the request.
    val reply = withContext(Dispatchers.IO) { withTimeout(timeout) { post<JsonObject>(path, body = emptyMap<String, String>()) } }
    val terminal = reply["terminal"]
    val pending = terminal?.get("state")?.stringValue == "pending"
    val reason = terminal?.get("pendingReason")?.stringValue
    val dir = terminal?.get("dir")?.stringValue?.trimEnd('/')?.substringAfterLast('/')?.takeIf { it.isNotEmpty() }
    return FireReceipt(held = pending && reason != "host_offline", waitsForHost = pending && reason == "host_offline", dir = dir)
}

/** iOS `RunTargetIntent` gives a request 15 s. */
internal val FIRE_TIMEOUT: Duration = 15.seconds

/** [block]'s value, or null when it failed (cancellation still propagates). */
internal suspend fun <T> attempt(block: suspend () -> T): T? =
    try {
        block()
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }
