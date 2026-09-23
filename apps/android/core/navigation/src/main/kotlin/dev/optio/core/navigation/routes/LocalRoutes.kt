package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import kotlinx.serialization.Serializable

// Owner: `:feature:local` (Agent A5). iOS: Features/Live/Local/*, Features/Library/Machines/*.

/** An Optio Local terminal; [compose] focuses the transcript composer on arrival. */
@Serializable
data class LocalTerminalRoute(val id: String, val compose: Boolean = false) : NavKey

/** A Local automation (`local_blueprints` row). */
@Serializable
data class LocalAutomationRoute(val id: String) : NavKey

/** A new Local automation ([id] null) or the edit form of an existing one. */
@Serializable
data class LocalAutomationFormRoute(val id: String? = null) : NavKey

/** One paired machine (`local_hosts` row): its directories, terminals and automations. */
@Serializable
data class LocalHostRoute(val id: String) : NavKey
