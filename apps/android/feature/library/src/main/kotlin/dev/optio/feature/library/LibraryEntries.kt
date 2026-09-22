package dev.optio.feature.library

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.NewConnectionRoute
import dev.optio.core.navigation.routes.NewRepoRoute
import dev.optio.core.navigation.routes.PromptDetailRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.RepoSettingsRoute
import dev.optio.core.navigation.routes.SharedDirectoriesRoute
import dev.optio.core.ui.PlaceholderScreen

/** Registers `:feature:library`'s routes. Stubs: Agent A7 builds prompts, repos and connections. */
fun EntryProviderScope<NavKey>.libraryEntries() {
    entry<PromptDetailRoute> { key -> PlaceholderScreen(title = if (key.id == null) "New prompt" else "Prompt", detail = key.toString()) }
    entry<RepoDetailRoute> { key -> PlaceholderScreen(title = "Repo", detail = key.toString()) }
    entry<RepoSettingsRoute> { key -> PlaceholderScreen(title = "Repo settings", detail = key.toString()) }
    entry<SharedDirectoriesRoute> { key -> PlaceholderScreen(title = "Shared directories", detail = key.toString()) }
    entry<NewRepoRoute> { key -> PlaceholderScreen(title = "Add repo", detail = key.toString()) }
    entry<ConnectionDetailRoute> { key -> PlaceholderScreen(title = "Connection", detail = key.toString()) }
    entry<NewConnectionRoute> { key -> PlaceholderScreen(title = "New connection", detail = key.toString()) }
}
