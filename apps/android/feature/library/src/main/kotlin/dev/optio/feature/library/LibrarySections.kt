package dev.optio.feature.library

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ConnectionDetailRoute
import dev.optio.core.navigation.routes.NewConnectionRoute
import dev.optio.core.navigation.routes.NewRepoRoute
import dev.optio.core.navigation.routes.PromptDetailRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.navigation.routes.RepoSettingsRoute
import dev.optio.core.navigation.routes.SharedDirectoriesRoute
import dev.optio.core.ui.PlaceholderSection
import dev.optio.core.ui.hub.HubActions

/** Library › Prompts (iOS `PromptsListView`). Stub: Agent A7 builds it. */
@Composable
fun PromptsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection("Prompts", contentPadding, modifier, samples = listOf(PromptDetailRoute("sample-prompt")))
}

/**
 * Library › Repos (iOS `ReposListView`). Stub: Agent A7 builds it.
 * Demonstrates the hub slot API with an "Add repo" top-bar action.
 */
@Composable
fun ReposSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val navigator = LocalNavigator.current
    HubActions {
        IconButton(onClick = { navigator.push(NewRepoRoute) }, modifier = Modifier.testTag("add-repo")) {
            Icon(Icons.Filled.Add, contentDescription = "Add repo")
        }
    }
    PlaceholderSection(
        title = "Repos",
        contentPadding = contentPadding,
        modifier = modifier,
        samples =
            listOf(
                RepoDetailRoute("sample-repo"),
                RepoSettingsRoute("sample-repo"),
                SharedDirectoriesRoute(repoId = "sample-repo"),
            ),
    )
}

/** Library › Connections (iOS `ConnectionsView`). Stub: Agent A7 builds it. */
@Composable
fun ConnectionsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    PlaceholderSection(
        title = "Connections",
        contentPadding = contentPadding,
        modifier = modifier,
        samples = listOf(ConnectionDetailRoute("sample-connection"), NewConnectionRoute(providerId = "notion")),
    )
}
