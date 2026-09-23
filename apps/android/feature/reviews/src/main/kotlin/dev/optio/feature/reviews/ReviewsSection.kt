package dev.optio.feature.reviews

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.CallMerge
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.FilterList
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material.icons.filled.Check
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.Navigator
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.routes.PullRequestRoute
import dev.optio.core.navigation.routes.ReviewDetailRoute
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
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.core.ui.toast.Toaster
import java.time.Instant

/**
 * Work › Reviews (iOS `ReviewsListView`, web `/reviews`): open PRs across the workspace's repos with
 * their review state or verdict, a "paste a PR URL" launcher, a state filter and (with several
 * repos) a repo filter. A row opens its review, or the PR's summary when it has none; a long press
 * offers "Review with Optio" / "Re-review", "Approve & merge" and "Open on GitHub".
 */
@Composable
fun ReviewsSection(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val model = viewModel(key = "reviews-list") { ReviewsListViewModel(api) }
    val state by model.state.collectAsStateWithLifecycle()
    val ui by model.ui.collectAsStateWithLifecycle()
    val confirm = rememberConfirmState()

    // Every time the section shows (iOS rebuilds the list model per section switch).
    LaunchedEffect(model) { model.refresh() }
    LaunchedEffect(model) {
        model.events.collect { event -> handleEvent(event, toaster, navigator) }
    }

    val repos = state.value?.repos.orEmpty()
    if (repos.size > 1) {
        HubActions { RepoFilterButton(repos = repos, selection = ui.repoFilter, onSelect = model::setRepoFilter) }
    }

    ReviewsContent(
        state = state,
        ui = ui,
        filtered = state.value?.let { model.filtered(it, ui.stateFilter) }.orEmpty(),
        canMutate = Roles.canMutate,
        contentPadding = contentPadding,
        modifier = modifier,
        onRefresh = model::reload,
        onRetry = model::refresh,
        onPrUrlChange = model::setPrUrl,
        onLaunchUrl = model::launchFromUrlField,
        onStateFilter = model::setStateFilter,
        onOpen = { pr ->
            val review = pr.review
            navigator.push(if (review != null) ReviewDetailRoute(review.id) else pr.toRoute())
        },
        onReview = { pr -> model.launchReview(pr.url) },
        onMerge = { pr ->
            confirm.ask(
                title = "Approve and merge PR #${pr.number}?",
                message = "This skips agent review.",
                confirmLabel = "Approve & squash-merge",
                destructive = true,
            ) { model.approveAndMerge(pr) }
        },
        onOpenExternal = navigator::openExternal,
        onOpenRepos = { navigator.open(Section.REPOS) },
    )
    ConfirmHost(confirm)
}

internal fun PullRequestSummary.toRoute() = PullRequestRoute(
    url = url,
    number = number,
    title = title,
    repo = repo?.fullName,
    author = author,
    updatedAt = updatedAt?.let(ReviewDates::iso),
    draft = draft == true,
    labels = labels?.takeIf { it.isNotEmpty() }?.joinToString(" · "),
)

/** The list itself, stateless (screenshot tests render it with sample data). */
@Composable
internal fun ReviewsContent(
    state: LoadState<ReviewsListViewModel.Data>,
    ui: ReviewsListViewModel.Ui,
    filtered: List<PullRequestSummary>,
    canMutate: Boolean,
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    onRefresh: suspend () -> Unit = {},
    onRetry: () -> Unit = {},
    onPrUrlChange: (String) -> Unit = {},
    onLaunchUrl: () -> Unit = {},
    onStateFilter: (String) -> Unit = {},
    onOpen: (PullRequestSummary) -> Unit = {},
    onReview: (PullRequestSummary) -> Unit = {},
    onMerge: (PullRequestSummary) -> Unit = {},
    onOpenExternal: (String) -> Unit = {},
    onOpenRepos: () -> Unit = {},
) {
    val data = state.value
    val now = rememberNow()
    PullRefresh(onRefresh = onRefresh, modifier = modifier.testTag("reviews-list")) {
        LazyColumn(
            // Dims PRs from an earlier load while a refetch (a repo filter, a pull) runs, like the Inbox.
            modifier = Modifier.fillMaxSize().readableWidth().dimmedWhileLoading(state.isLoading && data != null),
            contentPadding = contentPadding,
        ) {
            if (canMutate) {
                item(key = "url") {
                    PrUrlField(
                        text = ui.prUrl,
                        launching = ui.launchingUrl,
                        onTextChange = onPrUrlChange,
                        onSubmit = onLaunchUrl,
                        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.xs),
                    )
                }
            }
            item(key = "filter") {
                ChipPicker(options = ReviewFormat.stateOptions, selection = ui.stateFilter, onSelect = onStateFilter)
            }
            if (state is LoadState.Failed) {
                // Alone, or above PRs from an earlier load that are now stale.
                item(key = "error") { ErrorRow(error = state.error, what = "pull requests", retry = onRetry) }
            }
            when {
                data == null && state is LoadState.Failed -> Unit
                data == null -> item(key = "skeleton") { SkeletonRows() }
                filtered.isEmpty() -> item(key = "empty") {
                    val label = ReviewFormat.stateOptions.firstOrNull { it.first == ui.stateFilter }?.second?.lowercase() ?: "matching"
                    EmptyState(
                        title = if (data.prs.isEmpty()) "No open pull requests" else "No $label PRs",
                        icon = Icons.AutoMirrored.Outlined.CallMerge,
                        message = when {
                            data.repos.isEmpty() -> "Add a repo first under Library › Repos."
                            data.prs.isEmpty() -> "Pull requests from your repos appear here."
                            else -> "Nothing matches this filter."
                        },
                        actionTitle = if (data.repos.isEmpty()) "Open Repos" else null,
                        action = onOpenRepos,
                    )
                }
                else -> items(filtered, key = { it.key }) { pr ->
                    PullRequestRow(
                        pr = pr,
                        busy = ui.reviewingUrl == pr.url || ui.mergingUrl == pr.url,
                        now = now,
                        canMutate = canMutate,
                        onOpen = { onOpen(pr) },
                        onReview = { onReview(pr) },
                        onMerge = { onMerge(pr) },
                        onOpenExternal = { onOpenExternal(pr.url) },
                    )
                    InsetDivider()
                }
            }
        }
    }
}

/** "Paste a PR URL to review": a capsule field with a send button (iOS's top list row). */
@Composable
internal fun PrUrlField(
    text: String,
    launching: Boolean,
    onTextChange: (String) -> Unit,
    onSubmit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val canSubmit = text.isNotBlank() && !launching
    Row(
        modifier = modifier
            .fillMaxWidth()
            .background(colors.fillTertiary, Radius.capsuleShape)
            .padding(start = Spacing.m, end = 5.dp, top = 5.dp, bottom = 5.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(Icons.Outlined.Link, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(18.dp))
        BasicTextField(
            value = text,
            onValueChange = onTextChange,
            singleLine = true,
            textStyle = OptioTheme.type.body.copy(color = colors.label),
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, imeAction = ImeAction.Go, autoCorrectEnabled = false),
            keyboardActions = KeyboardActions(onGo = { if (canSubmit) onSubmit() }),
            modifier = Modifier.weight(1f).testTag("pr-url-field"),
            decorationBox = { inner ->
                Box {
                    if (text.isEmpty()) Text("Paste a PR URL to review", style = OptioTheme.type.body, color = colors.tertiaryLabel, maxLines = 1)
                    inner()
                }
            },
        )
        IconButton(
            onClick = onSubmit,
            enabled = canSubmit,
            shape = CircleShape,
            colors = IconButtonDefaults.filledIconButtonColors(
                containerColor = MaterialTheme.colorScheme.primary,
                contentColor = MaterialTheme.colorScheme.onPrimary,
                disabledContainerColor = colors.tertiaryLabel,
                disabledContentColor = colors.page,
            ),
            modifier = Modifier.size(32.dp).testTag("pr-url-review"),
        ) {
            if (launching) {
                CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
            } else {
                Icon(Icons.Filled.ArrowUpward, contentDescription = "Review", modifier = Modifier.size(18.dp))
            }
        }
    }
}

/**
 * `dot · title` / `#n · repo · author · 2h` with one trailing verdict or state (iOS
 * `PullRequestRow`). Long press opens the row's actions (iOS swipe actions).
 */
@Composable
internal fun PullRequestRow(
    pr: PullRequestSummary,
    busy: Boolean,
    now: Instant,
    canMutate: Boolean,
    onOpen: () -> Unit,
    onReview: () -> Unit,
    onMerge: () -> Unit,
    onOpenExternal: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    val review = pr.review
    val tone = review?.state?.let(ReviewFormat::stateTone) ?: if (pr.draft == true) Tone.IDLE else null
    val (trailing, trailingTone) = when {
        busy -> "Working…" to Tone.WORKING
        review?.verdict != null -> ReviewFormat.verdictLabel(review.verdict) to ReviewFormat.verdictTone(review.verdict)
        review?.state != null -> ReviewFormat.stateLabel(review.state) to ReviewFormat.stateTone(review.state).takeIf { it == Tone.ACCENT }
        pr.draft == true -> "Draft" to null
        else -> (pr.updatedAt?.relativeDescription(now) ?: "") to null
    }
    val reviewLabel = when {
        review == null -> "Review with Optio"
        review.canReReview -> "Re-review"
        else -> null
    }
    val openLabel = "Open on ${pr.platformName}"
    Box {
        OptioRow(
            title = pr.title,
            tone = tone,
            meta = metaText(mono("#${pr.number}"), pr.repo?.fullName, pr.author, pr.updatedAt?.relativeDescription(now)),
            trailing = trailing.ifEmpty { null },
            trailingTone = trailingTone,
            footer = pr.labels?.takeIf { it.isNotEmpty() }?.let { metaText(it) },
            onClick = onOpen,
            onLongClick = { menu = true },
            onClickLabel = if (review != null) "Open review" else "Open pull request",
            modifier = Modifier
                .testTag("pr-row-${pr.number}")
                .semantics {
                    customActions = buildList {
                        if (canMutate && reviewLabel != null) add(CustomAccessibilityAction(reviewLabel) { onReview(); true })
                        if (canMutate) add(CustomAccessibilityAction("Approve & merge") { onMerge(); true })
                        add(CustomAccessibilityAction(openLabel) { onOpenExternal(); true })
                    }
                },
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }) {
            if (canMutate && reviewLabel != null) {
                DropdownMenuItem(
                    text = { Text(reviewLabel) },
                    leadingIcon = { Icon(if (review == null) Icons.Outlined.Visibility else Icons.Outlined.Replay, contentDescription = null) },
                    onClick = {
                        menu = false
                        onReview()
                    },
                )
            }
            if (canMutate) {
                DropdownMenuItem(
                    text = { Text("Approve & merge…") },
                    leadingIcon = { Icon(Icons.AutoMirrored.Outlined.CallMerge, contentDescription = null) },
                    onClick = {
                        menu = false
                        onMerge()
                    },
                )
            }
            DropdownMenuItem(
                text = { Text(openLabel) },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                onClick = {
                    menu = false
                    onOpenExternal()
                },
            )
        }
    }
}

/** The hub's repo filter (iOS toolbar `Menu` + `Picker("Repo")`). */
@Composable
internal fun RepoFilterButton(
    repos: List<RepoSummary>,
    selection: String,
    onSelect: (String) -> Unit,
    extra: (@Composable (dismiss: () -> Unit) -> Unit)? = null,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("repo-filter")) {
            Icon(
                Icons.Outlined.FilterList,
                contentDescription = "Filter by repo",
                tint = if (selection.isEmpty()) LocalContentColor.current else OptioTheme.colors.accent,
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            FilterItem("All repos", selected = selection.isEmpty()) {
                open = false
                onSelect("")
            }
            repos.forEach { repo ->
                FilterItem(repo.displayName, selected = selection == repo.id) {
                    open = false
                    onSelect(repo.id)
                }
            }
            extra?.invoke { open = false }
        }
    }
}

/** A single-choice menu item with a check on the current value. */
@Composable
internal fun FilterItem(
    label: String,
    selected: Boolean,
    onClick: () -> Unit,
) {
    DropdownMenuItem(
        text = { Text(label) },
        trailingIcon = if (selected) {
            { Icon(Icons.Filled.Check, contentDescription = "Selected") }
        } else {
            null
        },
        onClick = onClick,
    )
}

/** Toasts, navigation and dismissal requested by a screen model. */
internal fun handleEvent(
    event: ScreenEvent,
    toaster: Toaster,
    navigator: Navigator,
) {
    when (event) {
        is ScreenEvent.Toast -> toaster.success(event.message)
        is ScreenEvent.Failure -> toaster.error(event.error, event.what)
        is ScreenEvent.Open -> navigator.push(event.route)
        ScreenEvent.Close -> navigator.pop()
    }
}
