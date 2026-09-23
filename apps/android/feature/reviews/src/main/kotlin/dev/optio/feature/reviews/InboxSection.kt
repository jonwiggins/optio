package dev.optio.feature.reviews

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.RadioButtonUnchecked
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.dimmedWhileLoading
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster
import java.time.Instant

private val issueStates = listOf("open" to "Open", "closed" to "Closed", "all" to "All")

/** Longest issue body carried in a back-stack key (saved state stays small). */
private const val MAX_ROUTE_BODY = 16_000

/**
 * Work › Inbox (iOS `IssuesListView`): GitHub / GitLab issues and external tracker tickets across
 * the workspace, Open / Closed / All, filtered by repo from the hub bar (which also has "Assign all").
 * A row opens the issue; a long press assigns it to Optio or opens it on its host.
 */
@Composable
fun InboxSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val model = viewModel(key = "inbox") { InboxViewModel(api) }
    val issues by model.issues.collectAsStateWithLifecycle()
    val repos by model.repos.collectAsStateWithLifecycle()
    val filter by model.filter.collectAsStateWithLifecycle()
    val bulkBusy by model.bulkBusy.collectAsStateWithLifecycle()
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()

    LaunchedEffect(model) { model.refresh() }
    LaunchedEffect(model) { model.events.collect { handleEvent(it, toaster, navigator) } }

    val unassigned = issues.value.orEmpty().count { it.isAssignable }
    HubActions {
        if (bulkBusy) {
            CircularProgressIndicator(Modifier.size(20.dp), strokeWidth = 2.dp)
        } else {
            RepoFilterButton(repos = repos, selection = filter.repoId, onSelect = model::setRepo) { dismiss ->
                if (canMutate && unassigned > 0) {
                    HorizontalDivider()
                    DropdownMenuItem(
                        text = { Text("Assign all ($unassigned)") },
                        leadingIcon = { Icon(Icons.Outlined.Bolt, contentDescription = null) },
                        onClick = {
                            dismiss()
                            confirm.ask("Assign $unassigned issues to Optio?", confirmLabel = "Assign all") { model.assignAll() }
                        },
                    )
                }
            }
        }
    }

    InboxContent(
        issues = issues,
        repos = repos,
        filter = filter,
        canMutate = canMutate,
        contentPadding = contentPadding,
        modifier = modifier,
        onRefresh = model::reload,
        onRetry = model::refresh,
        onState = model::setState,
        onOpen = { issue -> navigator.push(issue.toRoute()) },
        onAssign = model::assign,
        onOpenExternal = navigator::openExternal,
        onOpenRepos = { navigator.open(Section.REPOS) },
    )
    ConfirmHost(confirm)
}

internal fun IssueRow.toRoute() = IssueDetailRoute(
    identity = identity,
    title = title,
    numberText = numberText,
    number = numberInt,
    repoId = repo?.id,
    repoName = repo?.fullName,
    source = source,
    state = state,
    url = url,
    author = author,
    assignee = assignee,
    body = body?.let { if (it.length > MAX_ROUTE_BODY) it.take(MAX_ROUTE_BODY) + "…" else it },
    taskId = optioTask?.taskId,
    assigned = optioTask != null,
)

@Composable
internal fun InboxContent(
    issues: LoadState<List<IssueRow>>,
    repos: List<RepoSummary>,
    filter: InboxViewModel.Filter,
    canMutate: Boolean,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onState: (String) -> Unit = {},
    onOpen: (IssueRow) -> Unit = {},
    onAssign: (IssueRow) -> Unit = {},
    onOpenExternal: (String) -> Unit = {},
    onOpenRepos: () -> Unit = {},
) {
    val list = issues.value
    val now = rememberNow()
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("inbox-list")) {
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth().dimmedWhileLoading(issues.isLoading && list != null),
            contentPadding = contentPadding,
        ) {
            item(key = "filter") { ChipPicker(options = issueStates, selection = filter.state, onSelect = onState) }
            if (issues is LoadState.Failed) {
                item(key = "error") { ErrorRow(error = issues.error, what = "issues", retry = onRetry) }
            }
            when {
                list == null && issues !is LoadState.Failed -> item(key = "skeleton") { SkeletonRows() }
                list != null && list.isEmpty() -> item(key = "empty") {
                    EmptyState(
                        title = if (filter.state == "all") "No issues" else "No ${filter.state} issues",
                        icon = Icons.Outlined.RadioButtonUnchecked,
                        message = if (repos.isEmpty()) "Add a repo first under Library › Repos." else "Issues from your repos appear here.",
                        actionTitle = if (repos.isEmpty()) "Open Repos" else null,
                        action = onOpenRepos,
                    )
                }
                list != null -> items(list, key = { it.identity }) { issue ->
                    IssueRowView(
                        issue = issue,
                        now = now,
                        canMutate = canMutate,
                        onOpen = { onOpen(issue) },
                        onAssign = { onAssign(issue) },
                        onOpenExternal = issue.url?.let { url -> { onOpenExternal(url) } },
                    )
                    InsetDivider()
                }
            }
        }
    }
}

/** `dot · title` / `#12 · owner/repo · @author · 2h`, trailing the Optio task's state (iOS `IssueRowView`). */
@Composable
internal fun IssueRowView(
    issue: IssueRow,
    now: Instant,
    canMutate: Boolean,
    onOpen: () -> Unit,
    onAssign: () -> Unit,
    onOpenExternal: (() -> Unit)?,
) {
    var menu by remember { mutableStateOf(false) }
    val trailing = ReviewFormat.issueTaskLabel(issue)
    val canAssign = canMutate && issue.isAssignable
    val hostLabel = "Open on ${issue.hostName}"
    val updated = issue.updatedAt?.let { ReviewDates.parse(it) }?.relativeDescription(now)
    Box {
        OptioRow(
            title = issue.title,
            tone = issue.optioTask?.let { Tone.forState(it.state) },
            meta = metaText(
                mono(issue.numberText),
                issue.repo?.fullName ?: issue.source,
                issue.author?.let { "@$it" },
                updated,
            ),
            trailing = trailing?.first,
            trailingTone = trailing?.second,
            footer = issue.labels?.takeIf { it.isNotEmpty() }?.let { metaText(it) },
            onClick = onOpen,
            onLongClick = if (canAssign || onOpenExternal != null) ({ menu = true }) else null,
            onClickLabel = "Open issue",
            modifier = Modifier
                .testTag("issue-row-${issue.numberText}")
                .semantics {
                    customActions = buildList {
                        if (canAssign) add(CustomAccessibilityAction("Assign to Optio") { onAssign(); true })
                        if (onOpenExternal != null) add(CustomAccessibilityAction(hostLabel) { onOpenExternal(); true })
                    }
                },
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (canAssign) {
                DropdownMenuItem(
                    text = { Text("Assign to Optio") },
                    leadingIcon = { Icon(Icons.Outlined.Bolt, contentDescription = null) },
                    onClick = {
                        menu = false
                        onAssign()
                    },
                )
            }
            if (onOpenExternal != null) {
                DropdownMenuItem(
                    text = { Text(hostLabel) },
                    leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                    onClick = {
                        menu = false
                        onOpenExternal()
                    },
                )
            }
        }
    }
}
