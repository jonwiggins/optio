package dev.optio.feature.workform

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.EditWorkRoute
import dev.optio.core.navigation.routes.NewWorkRoute

/**
 * Registers `:feature:workform`'s routes: the one creation form ([NewWorkRoute], optionally
 * prefilled from an example preset) and the same form reopened on saved recurring work
 * ([EditWorkRoute]: a scheduled Task, a Job or a Local automation).
 */
fun EntryProviderScope<NavKey>.workFormEntries() {
    entry<NewWorkRoute> { key -> NewWorkScreen(preset = key.preset) }
    entry<EditWorkRoute> { key -> EditWorkScreen(id = key.id) }
}
