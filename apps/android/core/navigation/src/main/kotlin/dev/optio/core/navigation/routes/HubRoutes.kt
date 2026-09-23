package dev.optio.core.navigation.routes

import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.Tab
import kotlinx.serialization.Serializable

// Owner: `:app` (the shell). The root entry of every tab's back stack.

/** The hub screen at the root of [tab]'s back stack (Overview, Work, Library, Insights, More). */
@Serializable
data class HubRoute(val tab: Tab) : NavKey
