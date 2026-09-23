package dev.optio.feature.local.api

import dev.optio.core.model.LocalAgentKind
import dev.optio.core.model.LocalAgentSessionMode
import dev.optio.core.model.LocalBlueprint
import dev.optio.core.model.LocalBlueprintSpawnMode
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalSpec
import dev.optio.core.model.LocalTranscriptEntry
import dev.optio.core.network.ApiClient
import java.time.Instant
import kotlinx.serialization.Contextual
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Endpoints of `apps/api/src/routes/local.ts`, as ApiClient extensions (iOS `LocalAPI.swift`, which
// mirrors the "Optio Local" block of the web's api-client.ts). Route-local envelopes live here.

// region Route-local rows and envelopes

/**
 * A trigger attached to a Local automation (`LocalTriggerSchema` in routes/local.ts). Declared here
 * because the route's row carries `targetType` / `targetId` and a `type` covering every trigger kind
 * (`schedule`, `webhook`, `ticket`, `github`, `slack`, `linear`, `manual`), which the generated
 * `WorkflowTrigger` doesn't model.
 */
@Serializable
data class LocalTrigger(
    val id: String,
    val targetType: String? = null,
    val targetId: String? = null,
    val type: String,
    val config: JsonObject? = null,
    val paramMapping: JsonObject? = null,
    val enabled: Boolean = true,
    @Contextual val lastFiredAt: Instant? = null,
    @Contextual val nextFireAt: Instant? = null,
    @Contextual val createdAt: Instant? = null,
    @Contextual val updatedAt: Instant? = null,
)

/**
 * `GET /api/local/terminals/:id/transcript`: one page of the stored conversation. [complete] is
 * true when fewer than `limit` entries came back, i.e. the caller has everything stored.
 */
@Serializable
data class LocalTranscriptPage(
    val entries: List<LocalTranscriptEntry> = emptyList(),
    val complete: Boolean = true,
)

@Serializable
internal data class HostsEnvelope(val hosts: List<LocalHost> = emptyList())

@Serializable
internal data class TerminalsEnvelope(val terminals: List<LocalTerminal> = emptyList())

@Serializable
internal data class TerminalEnvelope(val terminal: LocalTerminal)

@Serializable
internal data class BlueprintsEnvelope(val blueprints: List<LocalBlueprint> = emptyList())

@Serializable
internal data class BlueprintEnvelope(val blueprint: LocalBlueprint)

@Serializable
internal data class TriggersEnvelope(val triggers: List<LocalTrigger> = emptyList())

@Serializable
internal data class TriggerEnvelope(val trigger: LocalTrigger)

// endregion

// region Request bodies

@Serializable
data class CreateLocalTerminalBody(
    val hostId: String,
    val dir: String,
    val title: String? = null,
    val spec: LocalTerminalSpec = LocalTerminalSpec.Shell,
)

@Serializable
internal data class KillBody(val signal: String? = null)

@Serializable
internal data class InputBody(val data: String)

@Serializable
internal data class SnoozeBody(val minutes: Int)

@Serializable
internal data class RenameBody(val title: String)

@Serializable
internal data class SpawnBody(val params: Map<String, String> = emptyMap())

/**
 * An automation, for create (POST) and update (PATCH). Fields left null are omitted, matching
 * `blueprintBodySchema`. On a PATCH, [clearAgent] sends `agent: null` (a shell command), and
 * [clearLocation] sends `dir: null` / `repoUrl: null` for whichever of the two isn't set, so moving
 * an automation between "a directory", "a repo URL" and "the event's repo" really moves it (iOS's
 * `clearAgent`; the web editor sends the same explicit nulls).
 */
data class LocalBlueprintBody(
    val name: String? = null,
    val description: String? = null,
    val hostId: String? = null,
    val dir: String? = null,
    val repoUrl: String? = null,
    val commandTemplate: String? = null,
    val agent: LocalAgentKind? = null,
    val spawnMode: LocalBlueprintSpawnMode? = null,
    val sessionMode: LocalAgentSessionMode? = null,
    val enabled: Boolean? = null,
    val clearAgent: Boolean = false,
    val clearHost: Boolean = false,
    val clearDescription: Boolean = false,
    val clearLocation: Boolean = false,
) {
    /** The JSON the route takes: a map, so explicit nulls survive (`OptioJson` drops null properties). */
    fun toJson(): JsonObject {
        val out = LinkedHashMap<String, JsonElement>()
        name?.let { out["name"] = JsonPrimitive(it) }
        when {
            description != null -> out["description"] = JsonPrimitive(description)
            clearDescription -> out["description"] = JsonNull
        }
        when {
            hostId != null -> out["hostId"] = JsonPrimitive(hostId)
            clearHost -> out["hostId"] = JsonNull
        }
        when {
            dir != null -> out["dir"] = JsonPrimitive(dir)
            clearLocation -> out["dir"] = JsonNull
        }
        when {
            repoUrl != null -> out["repoUrl"] = JsonPrimitive(repoUrl)
            clearLocation -> out["repoUrl"] = JsonNull
        }
        commandTemplate?.let { out["commandTemplate"] = JsonPrimitive(it) }
        when {
            agent != null -> out["agent"] = JsonPrimitive(agent.raw)
            clearAgent -> out["agent"] = JsonNull
        }
        spawnMode?.let { out["spawnMode"] = JsonPrimitive(it.raw) }
        sessionMode?.let { out["sessionMode"] = JsonPrimitive(it.raw) }
        enabled?.let { out["enabled"] = JsonPrimitive(it) }
        return JsonObject(out)
    }
}

// endregion

// region Hosts

suspend fun ApiClient.listLocalHosts(): List<LocalHost> = get<HostsEnvelope>("/api/local/hosts").hosts

/** Unpairs a host (the server deletes its terminals too). */
suspend fun ApiClient.deleteLocalHost(id: String) = delete("/api/local/hosts/$id")

// endregion

// region Terminals

suspend fun ApiClient.listLocalTerminals(
    hostId: String? = null,
    state: String? = null,
): List<LocalTerminal> = get<TerminalsEnvelope>("/api/local/terminals", mapOf("hostId" to hostId, "state" to state)).terminals

suspend fun ApiClient.getLocalTerminal(id: String): LocalTerminal = get<TerminalEnvelope>("/api/local/terminals/$id").terminal

suspend fun ApiClient.createLocalTerminal(body: CreateLocalTerminalBody): LocalTerminal =
    post<TerminalEnvelope>("/api/local/terminals", body).terminal

/** Starts a `pending` (held) terminal. */
suspend fun ApiClient.startLocalTerminal(id: String): LocalTerminal = post<TerminalEnvelope>("/api/local/terminals/$id/start").terminal

/** SIGTERM by default; `SIGKILL` for "Force kill". */
suspend fun ApiClient.killLocalTerminal(
    id: String,
    signal: String? = null,
) = post("/api/local/terminals/$id/kill", KillBody(signal))

/** A new interactive terminal resuming the agent's own session (`claude --resume`); 409 without one. */
suspend fun ApiClient.resumeLocalTerminal(id: String): LocalTerminal =
    post<TerminalEnvelope>("/api/local/terminals/$id/resume", JsonObject(emptyMap())).terminal

/** "Later": out of the needs-you queue for [minutes] (server default 15, 1–1440). */
suspend fun ApiClient.snoozeLocalTerminal(
    id: String,
    minutes: Int,
): LocalTerminal = post<TerminalEnvelope>("/api/local/terminals/$id/snooze", SnoozeBody(minutes)).terminal

/** Clears a snooze so the terminal re-enters the needs-you queue. */
suspend fun ApiClient.unsnoozeLocalTerminal(id: String): LocalTerminal = delete<TerminalEnvelope>("/api/local/terminals/$id/snooze").terminal

suspend fun ApiClient.renameLocalTerminal(
    id: String,
    title: String,
): LocalTerminal = patch<TerminalEnvelope>("/api/local/terminals/$id", RenameBody(title)).terminal

/** REST fallback for stdin (the stream socket is the primary path); 409 unless running. */
suspend fun ApiClient.sendLocalTerminalInput(
    id: String,
    data: String,
) = post("/api/local/terminals/$id/input", InputBody(data))

/** Deletes a non-running terminal record. */
suspend fun ApiClient.deleteLocalTerminal(id: String) = delete("/api/local/terminals/$id")

/**
 * The conversation of an agent session (prompts, replies, tool calls), distilled by the daemon from
 * the agent CLI's own transcript. [after] fetches only entries past a seq.
 */
suspend fun ApiClient.getLocalTerminalTranscript(
    id: String,
    after: Long = 0,
    limit: Int = TRANSCRIPT_PAGE,
): LocalTranscriptPage =
    get<LocalTranscriptPage>(
        "/api/local/terminals/$id/transcript",
        mapOf("after" to after.takeIf { it > 0 }, "limit" to limit),
    )

/** The page size the web and iOS use. */
const val TRANSCRIPT_PAGE: Int = 2000

// endregion

// region Automations (blueprints)

suspend fun ApiClient.listLocalBlueprints(): List<LocalBlueprint> = get<BlueprintsEnvelope>("/api/local/blueprints").blueprints

suspend fun ApiClient.getLocalBlueprint(id: String): LocalBlueprint = get<BlueprintEnvelope>("/api/local/blueprints/$id").blueprint

suspend fun ApiClient.createLocalBlueprint(body: LocalBlueprintBody): LocalBlueprint =
    post<BlueprintEnvelope>("/api/local/blueprints", body.toJson()).blueprint

suspend fun ApiClient.updateLocalBlueprint(
    id: String,
    body: LocalBlueprintBody,
): LocalBlueprint = patch<BlueprintEnvelope>("/api/local/blueprints/$id", body.toJson()).blueprint

suspend fun ApiClient.deleteLocalBlueprint(id: String) = delete("/api/local/blueprints/$id")

/** A manual run ("Run now"): the terminal it spawned (pending when the automation holds). */
suspend fun ApiClient.spawnLocalBlueprint(
    id: String,
    params: Map<String, String> = emptyMap(),
): LocalTerminal = post<TerminalEnvelope>("/api/local/blueprints/$id/spawn", SpawnBody(params)).terminal

suspend fun ApiClient.listLocalBlueprintTriggers(id: String): List<LocalTrigger> =
    get<TriggersEnvelope>("/api/local/blueprints/$id/triggers").triggers

suspend fun ApiClient.createLocalBlueprintTrigger(
    id: String,
    type: String,
    config: JsonObject,
): LocalTrigger =
    post<TriggerEnvelope>(
        "/api/local/blueprints/$id/triggers",
        JsonObject(mapOf("type" to JsonPrimitive(type), "config" to config)),
    ).trigger

suspend fun ApiClient.setLocalBlueprintTriggerEnabled(
    id: String,
    triggerId: String,
    enabled: Boolean,
): LocalTrigger =
    patch<TriggerEnvelope>(
        "/api/local/blueprints/$id/triggers/$triggerId",
        JsonObject(mapOf("enabled" to JsonPrimitive(enabled))),
    ).trigger

suspend fun ApiClient.deleteLocalBlueprintTrigger(
    id: String,
    triggerId: String,
) = delete("/api/local/blueprints/$id/triggers/$triggerId")

// endregion
