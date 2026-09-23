@file:UseSerializers(FlexibleInstantSerializer::class)

package dev.optio.feature.sessions

import dev.optio.core.model.AgentLogEntry
import dev.optio.core.model.FlexibleInstantSerializer
import dev.optio.core.model.InteractiveSession
import dev.optio.core.model.SessionPr
import dev.optio.core.network.ApiClient
import java.time.Instant
import kotlinx.serialization.Serializable
import kotlinx.serialization.UseSerializers
import kotlinx.serialization.json.JsonElement

// Envelopes and local row types of `routes/sessions.ts` (iOS `SessionsAPI.swift`).

/** The repo's Claude model and the choices the chat's model picker offers. */
@Serializable
data class SessionModelConfig(
    val claudeModel: String? = null,
    val availableModels: List<String>? = null,
)

/** `GET /api/sessions/:id` → `{ session, modelConfig }`. */
@Serializable
data class SessionEnvelope(
    val session: InteractiveSession,
    val modelConfig: SessionModelConfig? = null,
)

/** A persisted chat event (`GET /api/sessions/:id/chat`); prompts you typed are `user_message` / stdin. */
@Serializable
data class SessionChatHistoryEvent(
    val id: String? = null,
    val stream: String? = null,
    val content: String = "",
    val logType: String? = null,
    val metadata: Map<String, JsonElement>? = null,
    val timestamp: Instant? = null,
) {
    /** A prompt the user typed (rendered as their bubble, not a log row). */
    val isUserMessage: Boolean
        get() = logType == "user_message" || stream == "stdin"

    fun asLogEntry(sessionId: String): AgentLogEntry =
        AgentLogEntry(
            taskId = sessionId,
            timestamp = timestamp?.toString().orEmpty(),
            type = AgentLogEntry.TypeValue.fromRawOrNull(logType ?: "text") ?: AgentLogEntry.TypeValue.TEXT,
            content = content,
            metadata = metadata,
        )
}

@Serializable
private data class SessionBody(val session: InteractiveSession)

@Serializable
private data class ChatBody(val events: List<SessionChatHistoryEvent> = emptyList())

@Serializable
private data class PrsBody(val prs: List<SessionPr> = emptyList())

/** `GET /api/sessions/:id`: the session and the repo's model config. */
suspend fun ApiClient.getSession(id: String): SessionEnvelope = get<SessionEnvelope>("/api/sessions/$id")

/** `POST /api/sessions/:id/end`: marks it ended and tears the pod down; the updated session. */
suspend fun ApiClient.endSession(id: String): InteractiveSession = post<SessionBody>("/api/sessions/$id/end").session

/** `GET /api/sessions/:id/chat`: the persisted conversation, oldest first. */
suspend fun ApiClient.sessionChatHistory(id: String, limit: Int = 1000): List<SessionChatHistoryEvent> =
    get<ChatBody>("/api/sessions/$id/chat", mapOf("limit" to limit)).events

/** `GET /api/sessions/:id/prs`: PRs opened during the session (picked up from the terminal). */
suspend fun ApiClient.listSessionPrs(id: String): List<SessionPr> = get<PrsBody>("/api/sessions/$id/prs").prs

/** The session's agent chat socket. */
fun sessionChatPath(id: String): String = "/ws/sessions/$id/chat"

/** The session's shell socket (binary PTY bytes both ways, JSON `resize`). */
fun sessionTerminalPath(id: String): String = "/ws/sessions/$id/terminal"
