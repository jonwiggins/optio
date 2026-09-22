package dev.optio.feature.workform

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.NewWorkRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:workform`'s routes. Stubs: Agent A2 builds the New / Edit work form. */
fun EntryProviderScope<NavKey>.workFormEntries() {
    entry<NewWorkRoute> { key -> PlaceholderScreen(title = "New work", detail = key.toString()) }
    entry<EditWorkRoute> { key -> PlaceholderScreen(title = "Edit work", detail = key.toString()) }
}
