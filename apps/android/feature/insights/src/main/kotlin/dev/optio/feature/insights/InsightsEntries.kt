package dev.optio.feature.insights

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.PodDetailRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:insights`'s routes. Stub: Agent A4 builds the pod detail. */
fun EntryProviderScope<NavKey>.insightsEntries() {
    entry<PodDetailRoute> { key -> PlaceholderScreen(title = "Pod", detail = key.toString()) }
}
