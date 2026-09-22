package dev.optio.feature.reviews

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.ReviewDetailRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:reviews`'s routes. Stub: Agent A4 builds the review detail. */
fun EntryProviderScope<NavKey>.reviewsEntries() {
    entry<ReviewDetailRoute> { key -> PlaceholderScreen(title = "Review", detail = key.toString()) }
}
