package dev.optio.feature.widgets.run

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

/**
 * Something the Run widget, the Run tile and run shortcuts can fire (iOS `RunTargetEntity`): a
 * Local blueprint (`GET /api/local/blueprints`) or a Job (`GET /api/jobs`) on one of the paired
 * servers.
 *
 * The [id] is namespaced `<serverId>|local:<uuid>` / `<serverId>|job:<uuid>`, so one picker lists
 * every server's targets and a tap fires on the right server whichever one is active. Ids without
 * the server prefix (configured before multi-server) fire on the active server.
 */
@Serializable
data class RunTarget(
    val id: String,
    val name: String,
    val kind: Kind,
    /** Local blueprints with `spawnMode = auto` start an agent immediately; `hold` waits in the cockpit. */
    val spawnMode: String? = null,
    /** Short name of the server this target lives on; set when several servers are paired. */
    val serverName: String? = null,
) {
    @Serializable
    enum class Kind(val raw: String) {
        @SerialName("local")
        LOCAL("local"),

        @SerialName("job")
        JOB("job"),
        ;

        companion object {
            fun fromRaw(raw: String): Kind? = entries.firstOrNull { it.raw == raw }
        }
    }

    /** The server this target lives on, or null for a legacy id (fires on the active server). */
    val serverId: String?
        get() = parse(id)?.serverId

    /** The blueprint or job id on its server. */
    val rawId: String?
        get() = parse(id)?.rawId

    /** The `POST` path that fires this target; null for a malformed id. */
    val firePath: String?
        get() = parse(id)?.firePath

    /** "Local blueprint" / "Job". */
    val kindLabel: String
        get() = if (kind == Kind.LOCAL) "Local blueprint" else "Job"

    /** The short kind word the Run widget shows in its corner ("blueprint" / "job"). */
    val kindWord: String
        get() = if (kind == Kind.LOCAL) "blueprint" else "job"

    /** Picker subtitle (iOS `displayRepresentation`): "Job", or "Job · MacBook" with several servers. */
    val subtitle: String
        get() = serverName?.let { "$kindLabel · $it" } ?: kindLabel

    /** The parts of a namespaced id. */
    data class Parts(
        val kind: Kind,
        val rawId: String,
        val serverId: String?,
    ) {
        val firePath: String
            get() =
                when (kind) {
                    Kind.LOCAL -> "/api/local/blueprints/$rawId/spawn"
                    Kind.JOB -> "/api/jobs/$rawId/runs"
                }
    }

    companion object {
        /** `<serverId>|<kind>:<rawId>`, or `<kind>:<rawId>` without a server. */
        fun makeId(
            serverId: String?,
            kind: Kind,
            rawId: String,
        ): String {
            val base = "${kind.raw}:$rawId"
            return serverId?.let { "$it|$base" } ?: base
        }

        /** Splits `[<serverId>|]local:<uuid>` / `[<serverId>|]job:<uuid>` back into its parts; null when malformed. */
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
            val kind = Kind.fromRaw(rest.substring(0, colon)) ?: return null
            return Parts(kind, rest.substring(colon + 1), serverId)
        }

        /**
         * The targets for configured [ids] (iOS `RunTargetQuery.entities(for:)`), given every live
         * target [all]: exact matches first; a legacy id (no server prefix) matches the same target on
         * the active server (the first in [all], which lists the active server first); an id that is
         * gone or offline stays resolvable as a placeholder ("Blueprint" / "Job") so a widget still
         * renders, named by [serverName] when its server is known.
         */
        fun resolve(
            ids: List<String>,
            all: List<RunTarget>,
            serverName: (String) -> String? = { null },
        ): List<RunTarget> {
            val found = all.filter { it.id in ids }.toMutableList()
            for (id in ids) {
                if (found.any { it.id == id }) continue
                val parts = parse(id) ?: continue
                if (parts.serverId != null) continue
                val match =
                    all.firstOrNull { target ->
                        parse(target.id)?.let { it.kind == parts.kind && it.rawId == parts.rawId } == true
                    } ?: continue
                found += match.copy(id = id)
            }
            if (found.size == ids.size) return found
            val missing =
                ids.filter { id -> found.none { it.id == id } }.mapNotNull { id ->
                    val parts = parse(id) ?: return@mapNotNull null
                    RunTarget(
                        id = id,
                        name = if (parts.kind == Kind.LOCAL) "Blueprint" else "Job",
                        kind = parts.kind,
                        serverName = parts.serverId?.let(serverName),
                    )
                }
            return found + missing
        }
    }
}
