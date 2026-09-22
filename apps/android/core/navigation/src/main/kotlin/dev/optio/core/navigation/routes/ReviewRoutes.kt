package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:reviews` (Agent A4). iOS: Features/Run/{Reviews,Issues}/*.

/** A code review (review subtask or external PR review). */
@Serializable
data class ReviewDetailRoute(val id: String) : NavKey
