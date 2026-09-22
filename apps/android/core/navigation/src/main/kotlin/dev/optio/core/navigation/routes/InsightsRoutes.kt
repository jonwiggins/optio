package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:insights` (Agent A4). iOS: Features/Insights/*.

/** A cluster pod (Insights › Cluster). */
@Serializable
data class PodDetailRoute(val id: String) : NavKey
