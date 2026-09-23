package dev.optio.feature.widgets.run

import dev.optio.core.glance.RunTarget
import dev.optio.core.model.get
import dev.optio.core.model.stringValue
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import kotlin.coroutines.cancellation.CancellationException
import kotlin.time.Duration
import kotlin.time.Duration.Companion.seconds
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.json.JsonObject

// The widget side of `:core:glance`'s RunTarget (iOS `RunTargetEntity` / `RunTargetIntent`): the
// words the Run widget and tile show, resolving configured ids, and firing with a receipt.

/** The blueprint or Job id on its server. */
val RunTarget.rawId: String?
    get() = RunTarget.parse(id)?.rawId

/** The short kind word in the Run widget's corner: "blueprint" / "job". */
val RunTarget.kindWord: String
    get() = if (kind == RunTarget.Kind.LOCAL) "blueprint" else "job"

/**
 * The targets for configured [ids] (iOS `RunTargetQuery.entities(for:)`), given every live target
 * [all] (active server first): exact matches first; a legacy id (no server prefix) matches the
 * same target on the active server, keeping the configured id; an id that is gone or offline stays
 * resolvable as a placeholder ("Blueprint" / "Job") so a widget still renders, named by
 * [serverName] when its server is known.
 */
fun resolveRunTargets(
    ids: List<String>,
    all: List<RunTarget>,
    serverName: (String) -> String? = { null },
): List<RunTarget> {
    val found = all.filter { it.id in ids }.toMutableList()
    for (id in ids) {
        if (found.any { it.id == id }) continue
        val parts = RunTarget.parse(id) ?: continue
        if (parts.serverId != null) continue
        val match = all.firstOrNull { target -> RunTarget.parse(target.id)?.let { it.kind == parts.kind && it.rawId == parts.rawId } == true } ?: continue
        found += match.copy(id = id)
    }
    if (found.size == ids.size) return found
    val missing =
        ids.filter { id -> found.none { it.id == id } }.mapNotNull { id ->
            val parts = RunTarget.parse(id) ?: return@mapNotNull null
            RunTarget(
                id = id,
                name = if (parts.kind == RunTarget.Kind.LOCAL) "Blueprint" else "Job",
                kind = parts.kind,
                serverName = parts.serverId?.let(serverName),
            )
        }
    return found + missing
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
 * wall clock) and reads what a blueprint spawned. Throws [ApiError] (or a timeout) on failure.
 */
internal suspend fun ApiClient.fire(
    target: RunTarget,
    timeout: Duration = FIRE_TIMEOUT,
): FireReceipt {
    val path = target.firePath ?: throw ApiError(0, "Not a blueprint or Job: ${target.id}")
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
