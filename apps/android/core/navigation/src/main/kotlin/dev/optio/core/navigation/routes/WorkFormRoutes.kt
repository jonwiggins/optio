package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:workform` (Agent A2). iOS: Features/Work/Feed/New/*, NewWorkSheet.swift.

/** The New work form; [preset] names an example preset to prefill. */
@Serializable
data class NewWorkRoute(val preset: String? = null) : NavKey

/** Edit a recurring definition (task config, job, or Local automation) in the same form. */
@Serializable
data class EditWorkRoute(val id: String) : NavKey
