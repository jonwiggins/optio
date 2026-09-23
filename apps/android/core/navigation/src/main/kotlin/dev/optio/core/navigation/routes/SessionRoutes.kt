package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:sessions` (Agent A6). iOS: Features/Live/Sessions/*.

/** An interactive pod session (`interactive_sessions` row). */
@Serializable
data class SessionDetailRoute(val id: String) : NavKey
