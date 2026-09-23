package dev.optio.feature.local

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.LocalAutomationFormRoute
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalHostRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.feature.local.automations.AutomationFormScreen
import dev.optio.feature.local.automations.AutomationScreen
import dev.optio.feature.local.machines.LocalHostScreen
import dev.optio.feature.local.terminal.LocalTerminalScreen

/** Registers `:feature:local`'s routes: Local terminals, automations (detail and form), machines. */
fun EntryProviderScope<NavKey>.localEntries() {
    entry<LocalTerminalRoute> { key -> LocalTerminalScreen(terminalId = key.id, compose = key.compose) }
    entry<LocalAutomationRoute> { key -> AutomationScreen(automationId = key.id) }
    entry<LocalAutomationFormRoute> { key -> AutomationFormScreen(automationId = key.id) }
    entry<LocalHostRoute> { key -> LocalHostScreen(hostId = key.id) }
}
