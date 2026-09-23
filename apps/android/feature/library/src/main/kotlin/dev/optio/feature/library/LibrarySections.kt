package dev.optio.feature.library

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import dev.optio.feature.library.connections.ConnectionsScreen
import dev.optio.feature.library.prompts.PromptsScreen
import dev.optio.feature.library.repos.ReposScreen

// The Library hub's sections from this module (iOS `LibraryHubView` switches between them; the hub
// itself lives in `:app`, Machines in `:feature:local`). iOS's hub also owned a `MoreContext` for
// role gating; here every section reads `LocalCurrentUser` through `Roles` instead.

/**
 * Library › Prompts (iOS `PromptsListView`): the named templates with a kind filter; members get
 * a "New prompt" action and swipe-to-delete.
 */
@Composable
fun PromptsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PromptsScreen(contentPadding, modifier)
}

/** Library › Repos (iOS `ReposListView`): the workspace's repositories; admins get "Add repository". */
@Composable
fun ReposSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    ReposScreen(contentPadding, modifier)
}

/**
 * Library › Connections (iOS `ConnectionsView`): active connections, the provider catalogue (admins
 * tap a provider to add a connection) and the global MCP servers.
 */
@Composable
fun ConnectionsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    ConnectionsScreen(contentPadding, modifier)
}
