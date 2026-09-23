package dev.optio.feature.work

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey

/**
 * Registers `:feature:work`'s routes: none. The Work list is a hub section ([WorkListSection]); its
 * rows open other features' detail routes (`WorkDestination.route()` in `:core:workfeed`:
 * `TaskDetailRoute`, `ScheduledDetailRoute`, `JobDetailRoute`, `LocalTerminalRoute`,
 * `LocalAutomationRoute`, `SessionDetailRoute`, `AgentDetailRoute`).
 */
fun EntryProviderScope<NavKey>.workEntries() {
    // No routes of its own.
}
