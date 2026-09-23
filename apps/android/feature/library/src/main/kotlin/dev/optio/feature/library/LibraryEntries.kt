package dev.optio.feature.library

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.NewConnectionRoute
import dev.optio.core.navigation.routes.NewRepoRoute
import dev.optio.core.navigation.routes.PromptDetailRoute
import dev.optio.core.navigation.routes.PromptEditRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.RepoSettingsRoute
import dev.optio.core.navigation.routes.SharedDirectoriesRoute
import dev.optio.feature.library.connections.ConnectionDetailScreen
import dev.optio.feature.library.connections.NewConnectionScreen
import dev.optio.feature.library.prompts.PromptDetailScreen
import dev.optio.feature.library.prompts.PromptEditorScreen
import dev.optio.feature.library.repos.NewRepoScreen
import dev.optio.feature.library.repos.RepoDetailScreen
import dev.optio.feature.library.repos.RepoSettingsScreen
import dev.optio.feature.library.repos.SharedDirectoriesScreen

/**
 * Registers `:feature:library`'s routes: prompt detail / new / edit, repo detail / settings /
 * shared directories / new, connection detail / new.
 */
fun EntryProviderScope<NavKey>.libraryEntries() {
    entry<PromptDetailRoute> { key ->
        val id = key.id
        if (id == null) PromptEditorScreen(id = null) else PromptDetailScreen(id)
    }
    entry<PromptEditRoute> { key -> PromptEditorScreen(id = key.id) }
    entry<RepoDetailRoute> { key -> RepoDetailScreen(key.id) }
    entry<RepoSettingsRoute> { key -> RepoSettingsScreen(key.id) }
    entry<SharedDirectoriesRoute> { key -> SharedDirectoriesScreen(key.repoId) }
    entry<NewRepoRoute> { NewRepoScreen() }
    entry<ConnectionDetailRoute> { key -> ConnectionDetailScreen(key.id) }
    entry<NewConnectionRoute> { key -> NewConnectionScreen(key.providerId) }
}
