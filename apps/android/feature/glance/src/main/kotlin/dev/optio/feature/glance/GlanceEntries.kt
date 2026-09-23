package dev.optio.feature.glance

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.WatchSettingsRoute
import dev.optio.core.ui.PlaceholderScreen

/**
 * Registers `:feature:glance`'s routes: the Watch and notification settings. Everything else in
 * this module (the Watch notification, alerts with actions, push, the background check) reaches
 * the app through `optio://` deep links rather than routes.
 */
fun EntryProviderScope<NavKey>.glanceEntries() {
    entry<WatchSettingsRoute> { PlaceholderScreen(title = "Watch & notifications") }
}
