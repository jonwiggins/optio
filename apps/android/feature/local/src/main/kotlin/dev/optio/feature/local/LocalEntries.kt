package dev.optio.feature.local

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.ui.PlaceholderScreen
import dev.optio.feature.local.terminal.LocalTerminalScreen

/** Registers `:feature:local`'s routes: Local terminals, automations, machines. */
fun EntryProviderScope<NavKey>.localEntries() {
    entry<LocalTerminalRoute> { key -> LocalTerminalScreen(terminalId = key.id, compose = key.compose) }
    entry<LocalAutomationRoute> { key -> PlaceholderScreen(title = "Automation", detail = key.toString()) }
}
