package dev.optio.feature.local

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.LocalAutomationRoute
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:local`'s routes. Stubs: Agent A5 builds the terminal and automation screens. */
fun EntryProviderScope<NavKey>.localEntries() {
    entry<LocalTerminalRoute> { key -> PlaceholderScreen(title = "Terminal", detail = key.toString()) }
    entry<LocalAutomationRoute> { key -> PlaceholderScreen(title = "Automation", detail = key.toString()) }
}
