@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.feature.agents

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.PersistentAgent
import dev.optio.core.model.PersistentAgentControlIntent
import dev.optio.core.model.PersistentAgentMessage
import dev.optio.core.model.PersistentAgentTurn
import dev.optio.core.network.ApiClient
import java.time.Instant
import java.time.OffsetDateTime
import java.time.format.DateTimeParseException
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

// Envelopes and local row types of `routes/persistent-agents.ts` (iOS `AgentsAPI.swift`).

/**
 * The detail route's `inbox` summary: messages not yet drained into a turn. [oldest] stays raw JSON:
 * the server computes it with a raw `MIN(received_at)` and sends Postgres text
 * (`2026-09-23 01:21:25.080298+00`), not ISO, whenever something is pending, which a strict date
 * would fail to decode (and with it the whole agent). Read it through [oldestInstant].
 */
@Serializable
data class PersistentAgentInbox(
    val pending: Int = 0,
    val oldest: JsonElement? = null,
) {
    /** [oldest] as an instant: ISO-8601, Postgres `timestamptz` text, or epoch millis. */
    val oldestInstant: Instant?
        get() = LenientDates.parse(oldest)
}

/** Dates as the API sends them, including the Postgres text some raw SQL aggregates leak. */
internal object LenientDates {
    private val offsetHours = Regex("([+-]\\d{2})$")

    fun parse(element: JsonElement?): Instant? {
        val primitive = element as? JsonPrimitive ?: return null
        if (!primitive.isString) return primitive.content.toDoubleOrNull()?.let { Instant.ofEpochMilli(it.toLong()) }
        val text = primitive.content.trim()
        if (text.isEmpty()) return null
        val iso = text.replaceFirst(' ', 'T').replace(offsetHours, "$1:00")
        return try {
            OffsetDateTime.parse(iso).toInstant()
        } catch (_: DateTimeParseException) {
            null
        }
    }
}

/** `GET /api/persistent-agents/:id` → `{ agent, inbox }`. */
@Serializable
data class PersistentAgentEnvelope(
    val agent: PersistentAgent,
    val inbox: PersistentAgentInbox? = null,
)

/** A `persistent_agent_turn_logs` row as `GET …/turns/:turnId` returns it (`logType`, not `type`). */
@Serializable
data class PersistentAgentTurnLog(
    val id: String? = null,
    val turnId: String? = null,
    val stream: String? = null,
    val content: String = "",
    val logType: String? = null,
    val metadata: Map<String, JsonElement>? = null,
    val timestamp: Instant? = null,
) {
    /** The row as an [AgentLogEntry] for `AgentLogView` (unknown or missing `logType` → text). */
    fun asLogEntry(agentId: String): AgentLogEntry =
        AgentLogEntry(
            taskId = agentId,
            timestamp = timestamp?.toString().orEmpty(),
            type = AgentLogEntry.TypeValue.fromRawOrNull(logType ?: "text") ?: AgentLogEntry.TypeValue.TEXT,
            content = content,
            metadata = metadata,
        )
}

/** `GET …/turns/:turnId` → `{ turn, logs }`. */
@Serializable
data class PersistentAgentTurnDetail(
    val turn: PersistentAgentTurn,
    val logs: List<PersistentAgentTurnLog> = emptyList(),
)

/**
 * A `workflow_triggers` row targeting a persistent agent. The generated `WorkflowTrigger` requires
 * a non-null `workflowId` and a closed type enum; these rows have neither, so they are local.
 */
@Serializable
data class PersistentAgentTrigger(
    val id: String,
    val type: String,
    val config: Map<String, JsonElement>? = null,
    val enabled: Boolean? = null,
    val lastFiredAt: Instant? = null,
    val nextFireAt: Instant? = null,
    val createdAt: Instant? = null,
) {
    /** The kind, when this client knows it. */
    val kind: AgentTriggerType?
        get() = AgentTriggerType.fromRaw(type)

    /** One line saying what fires it (cron, hook path, event filter…). */
    val summary: String
        get() = AgentTriggers.summary(type, config.orEmpty())
}

/**
 * Body of `POST /api/persistent-agents` (create). Null fields are omitted (`OptioJson`
 * `explicitNulls = false`); edits PATCH a JSON object instead ([AgentFormDraft.patch]) so they can clear fields.
 */
@Serializable
data class PersistentAgentInput(
    val slug: String? = null,
    val name: String? = null,
    val description: String? = null,
    val agentRuntime: String? = null,
    val model: String? = null,
    val systemPrompt: String? = null,
    val agentsMd: String? = null,
    val initialPrompt: String? = null,
    val podLifecycle: String? = null,
    val idlePodTimeoutMs: Int? = null,
    val maxTurnDurationMs: Int? = null,
    val maxTurns: Int? = null,
    val consecutiveFailureLimit: Int? = null,
    val enabled: Boolean? = null,
)

/** Body of `POST /api/persistent-agents/:id/triggers` (`schemas/trigger.ts` `CreateTriggerBodySchema`). */
@Serializable
data class PersistentAgentTriggerInput(
    val type: String,
    val config: JsonObject,
    val enabled: Boolean = true,
)

@Serializable
private data class AgentBody(val agent: PersistentAgent)

@Serializable
private data class MessagesBody(val messages: List<PersistentAgentMessage> = emptyList())

@Serializable
private data class TurnsBody(val turns: List<PersistentAgentTurn> = emptyList())

@Serializable
private data class TriggersBody(val triggers: List<PersistentAgentTrigger> = emptyList())

@Serializable
private data class TriggerBody(val trigger: PersistentAgentTrigger)

@Serializable
private data class MessageInput(val body: String)

@Serializable
private data class ControlInput(val intent: String)

/** `GET /api/persistent-agents/:id`: the agent and its inbox summary. */
suspend fun ApiClient.getPersistentAgent(id: String): PersistentAgentEnvelope = get<PersistentAgentEnvelope>("/api/persistent-agents/$id")

/** `POST /api/persistent-agents` (the server wakes it with the initial prompt). */
suspend fun ApiClient.createPersistentAgent(input: PersistentAgentInput): PersistentAgent =
    post<AgentBody>("/api/persistent-agents", body = input).agent

/**
 * `PATCH /api/persistent-agents/:id`. [patch] is a JSON object of the edited fields; a JSON `null`
 * clears a nullable field (description, model, prompts).
 */
suspend fun ApiClient.updatePersistentAgent(id: String, patch: JsonObject): PersistentAgent =
    patch<AgentBody>("/api/persistent-agents/$id", body = patch).agent

/** `DELETE /api/persistent-agents/:id` (the agent and all its turn history). */
suspend fun ApiClient.deletePersistentAgent(id: String) = delete("/api/persistent-agents/$id")

/** `POST /api/persistent-agents/:id/messages`: records the message and wakes the agent (202). */
suspend fun ApiClient.sendPersistentAgentMessage(id: String, body: String) =
    post("/api/persistent-agents/$id/messages", body = MessageInput(body))

/** `GET /api/persistent-agents/:id/messages`, newest first. */
suspend fun ApiClient.listPersistentAgentMessages(id: String, limit: Int = 100): List<PersistentAgentMessage> =
    get<MessagesBody>("/api/persistent-agents/$id/messages", mapOf("limit" to limit)).messages

/** `GET /api/persistent-agents/:id/turns`, newest first. */
suspend fun ApiClient.listPersistentAgentTurns(id: String, limit: Int = 50): List<PersistentAgentTurn> =
    get<TurnsBody>("/api/persistent-agents/$id/turns", mapOf("limit" to limit)).turns

/** `GET /api/persistent-agents/:id/turns/:turnId`: the turn and its logs. */
suspend fun ApiClient.getPersistentAgentTurn(id: String, turnId: String): PersistentAgentTurnDetail =
    get<PersistentAgentTurnDetail>("/api/persistent-agents/$id/turns/$turnId")

/** `POST /api/persistent-agents/:id/control`: pause / resume / archive / restart. */
suspend fun ApiClient.controlPersistentAgent(id: String, intent: PersistentAgentControlIntent) =
    post("/api/persistent-agents/$id/control", body = ControlInput(intent.raw))

/** `GET /api/persistent-agents/:id/triggers`, newest first. */
suspend fun ApiClient.listPersistentAgentTriggers(id: String): List<PersistentAgentTrigger> =
    get<TriggersBody>("/api/persistent-agents/$id/triggers").triggers

/** `POST /api/persistent-agents/:id/triggers`: any of the seven trigger types. */
suspend fun ApiClient.createPersistentAgentTrigger(id: String, input: PersistentAgentTriggerInput): PersistentAgentTrigger =
    post<TriggerBody>("/api/persistent-agents/$id/triggers", body = input).trigger

/** `DELETE /api/persistent-agents/:id/triggers/:triggerId`. */
suspend fun ApiClient.deletePersistentAgentTrigger(id: String, triggerId: String) =
    delete("/api/persistent-agents/$id/triggers/$triggerId")

/** The events socket of one agent: state, messages, turn start/halt and turn logs. */
fun agentEventsPath(id: String): String = "/ws/persistent-agents/$id/events"
