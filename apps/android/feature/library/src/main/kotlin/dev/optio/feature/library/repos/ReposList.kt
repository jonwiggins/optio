package dev.optio.feature.library.repos

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.NewRepoRoute
import dev.optio.core.navigation.routes.RepoDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.groupedItems
import dev.optio.feature.library.listRepos
import dev.optio.feature.library.listTopSpace
import dev.optio.feature.library.loadStateItems

/** Library › Repos (iOS `ReposListModel`). */
class ReposViewModel(private val api: ApiClient) : LibraryViewModel<List<RepoRow>>() {
    override suspend fun fetch(): List<RepoRow> = api.listRepos()
}

/** Library › Repos: the repositories, plus "Add repository" for admins. */
@Composable
internal fun ReposScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    vm: ReposViewModel = libraryViewModel { ReposViewModel(it) },
) {
    val navigator = LocalNavigator.current
    val isAdmin = Roles.isAdmin
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    HubActions {
        if (isAdmin) {
            IconButton(onClick = { navigator.push(NewRepoRoute) }, modifier = Modifier.testTag("add-repo")) {
                Icon(Icons.Filled.Add, contentDescription = "Add repository")
            }
        }
    }
    ReposContent(
        state = state,
        isAdmin = isAdmin,
        onRefresh = vm::refresh,
        onOpen = { navigator.push(RepoDetailRoute(it.id)) },
        onAdd = { navigator.push(NewRepoRoute) },
        contentPadding = contentPadding,
        modifier = modifier,
    )
}

/** The repos list (stateless). */
@Composable
internal fun ReposContent(
    state: LoadState<List<RepoRow>>,
    isAdmin: Boolean,
    onRefresh: () -> Unit,
    onOpen: (RepoRow) -> Unit,
    onAdd: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "repos-list") {
        loadStateItems(state, what = "repos", onRetry = onRefresh) { repos ->
            if (repos.isEmpty()) {
                item(key = "empty", contentType = "state") {
                    EmptyState(
                        title = "No repositories",
                        icon = Icons.Outlined.Folder,
                        message = if (isAdmin) "Add a repository to get started." else "Ask a workspace admin to add one.",
                        actionTitle = if (isAdmin) "Add repository" else null,
                        action = if (isAdmin) onAdd else null,
                    )
                }
            } else {
                listTopSpace()
                groupedItems(repos, key = { it.id }) { repo, position ->
                    GroupedRow(position) { RepoListRow(repo, onClick = { onOpen(repo) }) }
                }
            }
        }
    }
}

/** One repo (iOS `row(_:)`): name; branch · image preset · auto-merge · private. */
@Composable
internal fun RepoListRow(repo: RepoRow, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OptioRow(
        title = repo.displayName,
        meta = metaText(
            mono(repo.defaultBranch ?: "main"),
            repo.imagePreset ?: "base",
            if (repo.autoMerge == true) "auto-merge" else null,
            if (repo.isPrivate == true) "private" else null,
        ),
        titleMaxLines = 1,
        onClick = onClick,
        modifier = modifier.testTag("repo-${repo.id}"),
    )
}
