package dev.optio.feature.sessions

import androidx.navigation3.runtime.EntryProviderScope
import androidx.navigation3.runtime.NavKey
import dev.optio.core.navigation.routes.SessionDetailRoute

/** Registers `:feature:sessions`'s route: the interactive pod session (chat, terminal, PRs). */
fun EntryProviderScope<NavKey>.sessionsEntries() {
    entry<SessionDetailRoute> { key -> SessionDetailScreen(sessionId = key.id) }
}
