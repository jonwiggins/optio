package dev.optio.feature.agents

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.navigation.routes.AgentFormRoute
import dev.optio.core.navigation.routes.AgentTurnRoute

/** Registers `:feature:agents`'s routes: the agent (chat, turns, triggers, config), one turn, the form. */
fun EntryProviderScope<NavKey>.agentsEntries() {
    entry<AgentDetailRoute> { key -> AgentDetailScreen(agentId = key.id, compose = key.compose) }
    entry<AgentTurnRoute> { key -> AgentTurnScreen(agentId = key.agentId, turnId = key.turnId, turnNumber = key.turnNumber) }
    entry<AgentFormRoute> { key -> AgentFormScreen(agentId = key.id) }
}
