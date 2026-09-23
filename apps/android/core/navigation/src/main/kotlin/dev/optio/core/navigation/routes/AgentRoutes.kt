package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:agents` (Agent A6). iOS: Features/Live/Agents/*.

/** A persistent agent; [compose] focuses the message composer on arrival. */
@Serializable
data class AgentDetailRoute(val id: String, val compose: Boolean = false) : NavKey

/** Create ([id] null) or edit a persistent agent. */
@Serializable
data class AgentFormRoute(val id: String? = null) : NavKey

/**
 * One turn of a persistent agent: its prompt and logs (iOS `AgentTurnDetailView`, pushed from the
 * agent's Turns chip). [turnNumber] titles the screen before the turn loads (0 = unknown).
 */
@Serializable
data class AgentTurnRoute(val agentId: String, val turnId: String, val turnNumber: Int = 0) : NavKey
