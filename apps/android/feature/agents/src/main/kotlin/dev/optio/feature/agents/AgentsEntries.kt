package dev.optio.feature.agents

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.AgentFormRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:agents`'s routes. Stubs: Agent A6 builds agent chat and the agent form. */
fun EntryProviderScope<NavKey>.agentsEntries() {
    entry<AgentDetailRoute> { key -> PlaceholderScreen(title = "Agent", detail = key.toString()) }
    entry<AgentFormRoute> { key -> PlaceholderScreen(title = if (key.id == null) "New agent" else "Edit agent", detail = key.toString()) }
}
