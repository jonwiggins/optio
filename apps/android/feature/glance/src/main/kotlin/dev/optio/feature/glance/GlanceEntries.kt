package dev.optio.feature.glance

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey

/**
 * Registers `:feature:glance`'s routes (none yet). Widgets, Quick Settings tiles, the Watch
 * notification, shortcuts and periodic refresh live in this module (Agent A9); they reach the
 * app through `optio://` deep links rather than routes.
 */
fun EntryProviderScope<NavKey>.glanceEntries() {
    // No routes yet.
}
