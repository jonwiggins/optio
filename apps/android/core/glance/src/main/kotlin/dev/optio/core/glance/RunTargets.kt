package dev.optio.core.glance

import dev.optio.core.data.ServerClient
import dev.optio.core.data.SessionStore
import dev.optio.core.network.ApiError
import java.time.Instant
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.serialization.Serializable

/**
 * Something a Run widget / tile / shortcut can fire: a Local blueprint (`GET /api/local/blueprints`)
 * or a Job (`GET /api/jobs`) on one of the paired servers (port of iOS `RunTargetEntity`). The id
 * is namespaced (`<serverId>|local:<uuid>` / `<serverId>|job:<uuid>`) so one picker lists every
 * server's targets; ids without the server prefix fire on the active server.
 */
@Serializable
data class RunTarget(
    val id: String,
    val name: String,
    val kind: Kind,
    /** Local blueprints with `spawnMode = auto` start an agent at once; `hold` waits in the cockpit. */
    val spawnMode: String? = null,
    /** Short name of the server this target lives on; set when several are paired. */
    val serverName: String? = null,
) {
    @Serializable
    enum class Kind { LOCAL, JOB }

    /** Picker subtitle: "Local blueprint · MacBook" / "Job". */
    val subtitle: String
        get() {
            val kindLabel = if (kind == Kind.LOCAL) "Local blueprint" else "Job"
            return serverName?.let { "$kindLabel · $it" } ?: kindLabel
        }

    /** The server the id names (null = the active server). */
    val serverId: String?
        get() = parse(id)?.serverId

    /** `POST` path that fires this target. */
    val firePath: String?
        get() = parse(id)?.let { firePath(it.kind, it.rawId) }

    /** An `id` split into its parts. */
    data class Parts(
        val kind: Kind,
        val rawId: String,
        val serverId: String?,
    )

    companion object {
        private fun prefix(kind: Kind) = if (kind == Kind.LOCAL) "local" else "job"

        fun makeId(
            serverId: String?,
            kind: Kind,
            rawId: String,
        ): String {
            val base = "${prefix(kind)}:$rawId"
            return serverId?.let { "$it|$base" } ?: base
        }

        /** Splits `[<serverId>|]local:<uuid>` / `[<serverId>|]job:<uuid>`; null when it is neither. */
        fun parse(id: String): Parts? {
            var serverId: String? = null
            var rest = id
            val bar = rest.indexOf('|')
            if (bar >= 0) {
                serverId = rest.substring(0, bar)
                rest = rest.substring(bar + 1)
            }
            val colon = rest.indexOf(':')
            if (colon < 0) return null
            val kind =
                when (rest.substring(0, colon)) {
                    "local" -> Kind.LOCAL
                    "job" -> Kind.JOB
                    else -> return null
                }
            return Parts(kind, rest.substring(colon + 1), serverId)
        }

        fun firePath(
            kind: Kind,
            rawId: String,
        ): String =
            when (kind) {
                Kind.LOCAL -> "/api/local/blueprints/$rawId/spawn"
                Kind.JOB -> "/api/jobs/$rawId/runs"
            }

        /**
         * Blueprints and enabled Jobs on every paired server, active server first, blueprints before
         * jobs; each request fails independently (an offline server lists nothing).
         */
        suspend fun fetchAll(clients: List<ServerClient>): List<RunTarget> {
            val multi = clients.size > 1
            val out = mutableListOf<RunTarget>()
            for (c in clients) {
                val (blueprints, jobs) =
                    coroutineScope {
                        val b = async { runCatching { c.api.get<BlueprintsEnvelope>("/api/local/blueprints").blueprints }.getOrNull() }
                        val j = async { runCatching { c.api.get<JobsEnvelope>("/api/jobs").workflows }.getOrNull() }
                        b.await() to j.await()
                    }
                val label = if (multi) c.server.shortName else null
                out += blueprints.orEmpty().map { RunTarget(makeId(c.server.id, Kind.LOCAL, it.id), it.name, Kind.LOCAL, it.spawnMode, label) }
                out +=
                    jobs.orEmpty().filter { it.enabled ?: true }.map {
                        RunTarget(makeId(c.server.id, Kind.JOB, it.id), it.name, Kind.JOB, serverName = label)
                    }
            }
            return out
        }

        suspend fun fetchAll(session: SessionStore): List<RunTarget> = fetchAll(session.clients())

        /**
         * Fires [target] on its server (or the active one): `POST` [firePath]; records the start in
         * [store] for the "Started" flash. Throws [ApiError] when the server refuses or is unreachable.
         */
        suspend fun fire(
            session: SessionStore,
            target: RunTarget,
            store: GlanceStore,
            now: Instant = Instant.now(),
        ) {
            val path = target.firePath ?: throw ApiError(0, "Not a blueprint or Job: ${target.id}")
            val client = session.resolveClient(target.serverId) ?: throw ApiError(0, "Sign in to Optio first.")
            store.setArmed(target.id, null)
            client.api.post(path, body = emptyMap<String, Any?>())
            store.setStarted(target.id, now)
        }
    }
}

@Serializable
internal data class BlueprintRow(
    val id: String,
    val name: String = "",
    val spawnMode: String? = null,
)

@Serializable
internal data class BlueprintsEnvelope(
    val blueprints: List<BlueprintRow> = emptyList(),
)

@Serializable
internal data class JobRow(
    val id: String,
    val name: String = "",
    val enabled: Boolean? = null,
)

@Serializable
internal data class JobsEnvelope(
    val workflows: List<JobRow> = emptyList(),
)
