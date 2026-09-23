package dev.optio.feature.insights

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.PodDetailRoute

/** Registers `:feature:insights`'s screens: a cluster repo pod. */
fun EntryProviderScope<NavKey>.insightsEntries() {
    entry<PodDetailRoute> { key -> PodDetailScreen(podId = key.id) }
}
