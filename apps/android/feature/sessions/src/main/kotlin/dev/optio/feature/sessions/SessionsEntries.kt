package dev.optio.feature.sessions

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.SessionDetailRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:sessions`'s routes. Stub: Agent A6 builds the pod session screen. */
fun EntryProviderScope<NavKey>.sessionsEntries() {
    entry<SessionDetailRoute> { key -> PlaceholderScreen(title = "Session", detail = key.toString()) }
}
