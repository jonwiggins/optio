package dev.optio.feature.reviews

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListState
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.CallMerge
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.automirrored.outlined.Undo
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.MoreVert
import androidx.compose.material.icons.filled.Refresh
import androidx.compose.material.icons.outlined.AttachMoney
import androidx.compose.material.icons.outlined.Cancel
import androidx.compose.material.icons.outlined.CheckCircle
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Description
import androidx.compose.material.icons.outlined.Memory
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.TripOrigin
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.AgentLogEntry
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChatComposer
import dev.optio.core.ui.components.ConfirmDialog
import dev.optio.core.ui.components.DetailHeader
import dev.optio.core.ui.components.DetailTabs
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.PipelineStrip
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.Durations
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.log.AgentLogRow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.medium
import dev.optio.core.ui.toast.LocalToaster
import java.time.Instant

/** Everything the review detail draws, gathered from [ReviewDetailViewModel] (screenshots build it directly). */
internal data class ReviewDetailUi(
    val review: LoadState<PrReview>,
    val runs: List<PrReviewRun> = emptyList(),
    val prStatus: PrStatus? = null,
    val draft: ReviewDetailViewModel.Draft = ReviewDetailViewModel.Draft(),
    val busy: ReviewDetailViewModel.Busy = ReviewDetailViewModel.Busy(),
    val tab: ReviewDetailViewModel.Tab = ReviewDetailViewModel.Tab.ACTIVITY,
    val logs: List<AgentLogEntry> = emptyList(),
    val logsError: Throwable? = null,
    val userMessages: List<ReviewDetailViewModel.UserMessage> = emptyList(),
    val live: Boolean = false,
    val canMutate: Boolean = true,
)

/** The screen's callbacks (no-ops by default for previews and screenshots). */
internal class ReviewDetailActions(
    val onBack: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onRefresh: () -> Unit = {},
    val onTab: (ReviewDetailViewModel.Tab) -> Unit = {},
    val onOpenPr: () -> Unit = {},
    val onReReview: () -> Unit = {},
    val onCancel: () -> Unit = {},
    val onVerdict: (String) -> Unit = {},
    val onSummary: (String) -> Unit = {},
    val onAddComment: () -> Unit = {},
    val onRemoveComment: (Long) -> Unit = {},
    val onEditComment: (Long, (ReviewDetailViewModel.DraftComment) -> ReviewDetailViewModel.DraftComment) -> Unit = { _, _ -> },
    val onSave: () -> Unit = {},
    val onSubmit: () -> Unit = {},
    val onMerge: () -> Unit = {},
    val onSendChat: suspend (String) -> Unit = {},
)

/**
 * A PR review (iOS `ReviewDetailView`): PR link and state pipeline, then Draft (editable verdict,
 * summary and inline comments; Save / Submit / Merge), Activity (live agent logs with your chat
 * turns inline, and a composer once a draft exists) and Runs. The menu has View on GitHub,
 * Re-review, Refresh and Cancel Review.
 */
@Composable
internal fun ReviewDetailScreen(reviewId: String) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val model = viewModel(key = "review-$reviewId") { ReviewDetailViewModel(api, reviewId) }
    LifecycleStartEffect(model) {
        model.startLive()
        onStopOrDispose { model.stopLive() }
    }
    LaunchedEffect(model) { model.events.collect { handleEvent(it, toaster, navigator) } }

    val review by model.review.collectAsStateWithLifecycle()
    val runs by model.runs.collectAsStateWithLifecycle()
    val prStatus by model.prStatus.collectAsStateWithLifecycle()
    val draft by model.draft.collectAsStateWithLifecycle()
    val busy by model.busy.collectAsStateWithLifecycle()
    val tab by model.tab.collectAsStateWithLifecycle()
    val logs by model.logs.entries.collectAsStateWithLifecycle()
    val logsError by model.logs.error.collectAsStateWithLifecycle()
    val connected by model.logs.connected.collectAsStateWithLifecycle()
    val userMessages by model.userMessages.collectAsStateWithLifecycle()
    var cancelDialog by remember { mutableStateOf(false) }
    var mergeDialog by remember { mutableStateOf(false) }

    ReviewDetailContent(
        ui = ReviewDetailUi(
            review = review,
            runs = runs,
            prStatus = prStatus,
            draft = draft,
            busy = busy,
            tab = tab,
            logs = logs,
            logsError = logsError,
            userMessages = userMessages,
            live = connected,
            canMutate = Roles.canMutate,
        ),
        actions = ReviewDetailActions(
            onBack = navigator::pop,
            onRetry = model::retry,
            onRefresh = model::refresh,
            onTab = model::selectTab,
            onOpenPr = { review.value?.let { navigator.openExternal(it.prUrl) } },
            onReReview = model::reReview,
            onCancel = { cancelDialog = true },
            onVerdict = model::setVerdict,
            onSummary = model::setSummary,
            onAddComment = model::addComment,
            onRemoveComment = model::removeComment,
            onEditComment = model::updateComment,
            onSave = model::saveDraft,
            onSubmit = model::submit,
            onMerge = { mergeDialog = true },
            onSendChat = model::sendChat,
        ),
    )
    if (cancelDialog) {
        ConfirmDialog(
            title = "Cancel this review?",
            confirmLabel = "Cancel Review",
            dismissLabel = "Keep",
            destructive = true,
            onConfirm = model::cancel,
            onDismiss = { cancelDialog = false },
        )
    }
    if (mergeDialog) {
        MergeMethodDialog(
            title = mergeTitle(prStatus),
            onPick = { method ->
                mergeDialog = false
                model.merge(method)
            },
            onDismiss = { mergeDialog = false },
        )
    }
}

/** "Merge this PR?", or the CI warning when checks aren't green (iOS `mergeTitle`). */
internal fun mergeTitle(status: PrStatus?): String =
    if (status != null && status.isOpen && !status.checksOk) {
        "CI is ${status.checksStatus ?: "unknown"}. Branch protection may still block the merge. Merge anyway?"
    } else {
        "Merge this PR?"
    }

@Composable
internal fun ReviewDetailContent(
    ui: ReviewDetailUi,
    actions: ReviewDetailActions,
    modifier: Modifier = Modifier,
) {
    val review = ui.review.value
    Scaffold(
        modifier = modifier.testTag("review-detail"),
        containerColor = OptioTheme.colors.page,
        topBar = {
            TopAppBar(
                title = { Text(review?.let { "PR #${it.prNumber ?: 0}" } ?: "Review") },
                navigationIcon = {
                    IconButton(onClick = actions.onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
                actions = { if (review != null) ReviewMenu(review, ui, actions) },
            )
        },
        bottomBar = {
            if (review != null && review.hasDraft && ui.canMutate && ui.tab == ReviewDetailViewModel.Tab.ACTIVITY) {
                ChatComposer(
                    onSend = actions.onSendChat,
                    placeholder = "Ask the reviewer…",
                    enabled = !ui.busy.chatSending,
                )
            }
        },
    ) { padding ->
        Column(Modifier.fillMaxSize().padding(padding)) {
            when {
                review != null -> {
                    ReviewHeader(review, ui.prStatus, ui.live, onOpenPr = actions.onOpenPr)
                    DetailTabs(
                        options = ReviewDetailViewModel.Tab.entries.map { it to it.label },
                        selection = ui.tab,
                        onSelect = actions.onTab,
                    )
                    when (ui.tab) {
                        ReviewDetailViewModel.Tab.DRAFT -> DraftTab(review, ui, actions)
                        ReviewDetailViewModel.Tab.ACTIVITY -> ActivityTab(review, ui)
                        ReviewDetailViewModel.Tab.RUNS -> RunsTab(ui.runs)
                    }
                }
                ui.review is LoadState.Failed -> ErrorRow(error = ui.review.error, what = "the review", retry = actions.onRetry)
                else -> Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) { CircularProgressIndicator() }
            }
        }
    }
}

@Composable
private fun ReviewMenu(
    review: PrReview,
    ui: ReviewDetailUi,
    actions: ReviewDetailActions,
) {
    var open by remember { mutableStateOf(false) }
    Box {
        IconButton(onClick = { open = true }, enabled = !ui.busy.acting, modifier = Modifier.testTag("review-menu")) {
            Icon(Icons.Filled.MoreVert, contentDescription = "More")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text("View on ${review.platformName}") },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null) },
                onClick = {
                    open = false
                    actions.onOpenPr()
                },
            )
            if (ui.canMutate && review.canReReview) {
                DropdownMenuItem(
                    text = { Text("Re-review") },
                    leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Undo, contentDescription = null) },
                    onClick = {
                        open = false
                        actions.onReReview()
                    },
                )
            }
            DropdownMenuItem(
                text = { Text("Refresh") },
                leadingIcon = { Icon(Icons.Filled.Refresh, contentDescription = null) },
                onClick = {
                    open = false
                    actions.onRefresh()
                },
            )
            if (ui.canMutate && review.canCancel) {
                HorizontalDivider()
                DropdownMenuItem(
                    text = { Text("Cancel Review", color = MaterialTheme.colorScheme.error) },
                    leadingIcon = { Icon(Icons.Outlined.Cancel, contentDescription = null, tint = MaterialTheme.colorScheme.error) },
                    onClick = {
                        open = false
                        actions.onCancel()
                    },
                )
            }
        }
    }
}

/** The detail header plus the review pipeline (iOS `header(_:)`). */
@Composable
private fun ReviewHeader(
    review: PrReview,
    status: PrStatus?,
    live: Boolean,
    onOpenPr: () -> Unit,
) {
    val stateTone = ReviewFormat.stateTone(review.state)
    val secondary = when {
        review.state == "failed" && !review.errorMessage.isNullOrEmpty() -> review.errorMessage
        review.isWorking -> ReviewFormat.workingHint(review.state)
        else -> null
    }
    Column(Modifier.fillMaxWidth()) {
        DetailHeader(
            state = ReviewFormat.stateLabel(review.state),
            tone = if (stateTone == Tone.ACCENT) Tone.WORKING else stateTone,
            line = metaText(
                review.repoFullName,
                mono("#${review.prNumber ?: 0}"),
                review.verdict?.let(ReviewFormat::verdictLabel),
                if (review.origin == "auto") "auto" else null,
                status?.checksStatus?.let { "CI $it" },
                status?.reviewStatus?.let { "review ${it.replace('_', ' ')}" },
                status?.prState?.takeIf { it != "open" }?.let { "PR $it" },
            ),
            secondary = secondary?.let { androidx.compose.ui.text.AnnotatedString(it) },
            needsYou = ReviewFormat.needsYou(review.state),
        ) {
            if (live) StateDot(Tone.WORKING, size = 6.dp, modifier = Modifier.testTag("live-dot"))
            IconButton(onClick = onOpenPr, modifier = Modifier.size(32.dp).testTag("open-pr")) {
                Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = "Open pull request", modifier = Modifier.size(18.dp))
            }
        }
        PipelineStrip(
            steps = ReviewFormat.pipeline.map { it.second },
            current = ReviewFormat.pipelineStep(review.state),
            failed = ReviewFormat.pipelineFailed(review.state),
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
        )
    }
}

// region Draft

@Composable
private fun DraftTab(
    review: PrReview,
    ui: ReviewDetailUi,
    actions: ReviewDetailActions,
) {
    if (!review.hasDraft) {
        Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
            if (review.isWorking) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            EmptyState(
                title = if (review.isWorking) "Draft in progress" else "No draft",
                icon = Icons.Outlined.Description,
                message = if (review.isWorking) ReviewFormat.workingHint(review.state) else "This review has no draft to show.",
            )
        }
        return
    }
    val draft = ui.draft
    val editable = review.isEditable && ui.canMutate
    Column(
        Modifier
            .fillMaxSize()
            .verticalScroll(rememberScrollState())
            .imePadding()
            .readableWidth()
            .padding(bottom = Spacing.xl)
            .testTag("draft-tab"),
    ) {
        GroupedSection(header = "Verdict") {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.m, vertical = Spacing.s),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s),
            ) {
                ReviewFormat.verdicts.forEach { verdict ->
                    VerdictChip(
                        verdict = verdict,
                        selected = draft.verdict == verdict,
                        enabled = editable,
                        onClick = { actions.onVerdict(verdict) },
                        modifier = Modifier.weight(1f),
                    )
                }
            }
        }
        GroupedSection(header = "Review summary") {
            FormField(
                value = draft.summary,
                onValueChange = actions.onSummary,
                placeholder = "Summary for the PR author",
                enabled = editable,
                singleLine = false,
                modifier = Modifier.heightIn(min = 120.dp).testTag("draft-summary"),
            )
        }
        GroupedSection(header = "Inline comments (${draft.comments.size})") {
            draft.comments.forEachIndexed { index, comment ->
                if (index > 0) InsetDivider()
                CommentEditor(comment, editable, actions)
            }
            if (editable) {
                if (draft.comments.isNotEmpty()) InsetDivider()
                TextButton(
                    onClick = actions.onAddComment,
                    modifier = Modifier.padding(horizontal = Spacing.s).testTag("add-comment"),
                ) {
                    Icon(Icons.Filled.Add, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(Spacing.xs))
                    Text("Add comment")
                }
            } else if (draft.comments.isEmpty()) {
                Text(
                    "No inline comments",
                    style = OptioTheme.type.subheadline,
                    color = OptioTheme.colors.secondaryLabel,
                    modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                )
            }
        }
        DraftActions(review, ui, actions)
    }
}

@Composable
private fun VerdictChip(
    verdict: String,
    selected: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val tone = ReviewFormat.verdictTone(verdict)
    FilterChip(
        selected = selected,
        onClick = onClick,
        enabled = enabled,
        label = {
            Text(
                ReviewFormat.verdictLabel(verdict),
                style = OptioTheme.type.caption.medium(),
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        },
        leadingIcon = { Icon(ReviewFormat.verdictIcon(verdict), contentDescription = null, modifier = Modifier.size(16.dp)) },
        colors = FilterChipDefaults.filterChipColors(
            selectedContainerColor = tone.color.copy(alpha = 0.16f),
            selectedLabelColor = tone.textColor,
            selectedLeadingIconColor = tone.textColor,
            disabledSelectedContainerColor = tone.color.copy(alpha = 0.10f),
        ),
        modifier = modifier.testTag("verdict-$verdict"),
    )
}

@Composable
private fun CommentEditor(
    comment: ReviewDetailViewModel.DraftComment,
    editable: Boolean,
    actions: ReviewDetailActions,
) {
    Column(Modifier.fillMaxWidth().testTag("comment-${comment.key}")) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            FormField(
                value = comment.path,
                onValueChange = { v -> actions.onEditComment(comment.key) { it.copy(path = v) } },
                placeholder = "path/to/file.ts",
                enabled = editable,
                style = OptioTheme.type.monoFootnote,
                keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                modifier = Modifier.weight(1f),
            )
            FormField(
                value = comment.line,
                onValueChange = { v -> actions.onEditComment(comment.key) { it.copy(line = v.filter(Char::isDigit)) } },
                placeholder = "line",
                enabled = editable,
                style = OptioTheme.type.monoFootnote,
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Number),
                modifier = Modifier.width(72.dp),
            )
            if (editable) {
                IconButton(onClick = { actions.onRemoveComment(comment.key) }, modifier = Modifier.testTag("remove-comment")) {
                    Icon(Icons.Outlined.Delete, contentDescription = "Remove comment", tint = OptioTheme.colors.red, modifier = Modifier.size(20.dp))
                }
            }
        }
        FormField(
            value = comment.body,
            onValueChange = { v -> actions.onEditComment(comment.key) { it.copy(body = v) } },
            placeholder = "Comment",
            enabled = editable,
            singleLine = false,
            modifier = Modifier.padding(top = 0.dp),
        )
    }
}

@Composable
private fun DraftActions(
    review: PrReview,
    ui: ReviewDetailUi,
    actions: ReviewDetailActions,
) {
    val busy = ui.busy
    val status = ui.prStatus
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        if (review.isEditable && ui.canMutate) {
            if (ui.draft.dirty) {
                OutlinedButton(onClick = actions.onSave, enabled = !busy.saving, modifier = Modifier.fillMaxWidth().testTag("save-draft")) {
                    if (busy.saving) SmallSpinner()
                    Text("Save Draft")
                }
            }
            Button(
                onClick = actions.onSubmit,
                enabled = !busy.submitting && ui.draft.verdict.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().testTag("submit-review"),
            ) {
                if (busy.submitting) {
                    SmallSpinner(color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null, modifier = Modifier.size(18.dp))
                    Spacer(Modifier.width(Spacing.s))
                }
                Text("Submit Review")
            }
        }
        if (review.state == "submitted") {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Icon(Icons.Outlined.CheckCircle, contentDescription = null, tint = OptioTheme.colors.green, modifier = Modifier.size(18.dp))
                Text(
                    "Submitted" + if (review.autoSubmitted == true) " automatically" else "",
                    style = OptioTheme.type.subheadline,
                    color = OptioTheme.colors.green,
                )
            }
        }
        if (ui.canMutate) {
            OutlinedButton(
                onClick = actions.onMerge,
                enabled = !busy.merging && status?.isOpen == true,
                modifier = Modifier.fillMaxWidth().testTag("merge-pr"),
            ) {
                if (busy.merging) SmallSpinner() else Icon(Icons.AutoMirrored.Outlined.CallMerge, contentDescription = null, modifier = Modifier.size(18.dp))
                Spacer(Modifier.width(Spacing.s))
                Text(if (status != null && status.isOpen && !status.checksOk) "Merge anyway" else "Merge PR")
            }
        }
        if (status != null && !status.isOpen) {
            Text("PR is ${status.prState ?: "closed"}", style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
        }
    }
}

@Composable
private fun SmallSpinner(color: androidx.compose.ui.graphics.Color = MaterialTheme.colorScheme.primary) {
    CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp, color = color)
    Spacer(Modifier.width(Spacing.s))
}

/** A plain text field on a card row, like an iOS `Form` field. */
@Composable
internal fun FormField(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    singleLine: Boolean = true,
    style: TextStyle = OptioTheme.type.body,
    keyboardOptions: KeyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
) {
    val colors = OptioTheme.colors
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        enabled = enabled,
        singleLine = singleLine,
        textStyle = style.copy(color = if (enabled) colors.label else colors.secondaryLabel),
        cursorBrush = SolidColor(colors.accent),
        keyboardOptions = keyboardOptions,
        modifier = modifier.fillMaxWidth(),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m)) {
                if (value.isEmpty()) Text(placeholder, style = style, color = colors.tertiaryLabel, maxLines = 1)
                inner()
            }
        },
    )
}

@Composable
private fun MergeMethodDialog(
    title: String,
    onPick: (String) -> Unit,
    onDismiss: () -> Unit,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("merge-dialog"),
        icon = { Icon(Icons.AutoMirrored.Outlined.CallMerge, contentDescription = null) },
        title = { Text(title) },
        text = {
            Column {
                ReviewFormat.mergeMethods.forEach { (method, label) ->
                    TextButton(onClick = { onPick(method) }, modifier = Modifier.fillMaxWidth().testTag("merge-$method")) {
                        Text(label, modifier = Modifier.fillMaxWidth())
                    }
                }
            }
        },
        confirmButton = {},
        dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("dismiss")) { Text("Cancel") } },
    )
}

// endregion

// region Activity

@Composable
private fun ActivityTab(
    review: PrReview,
    ui: ReviewDetailUi,
) {
    if (ui.logs.isEmpty() && ui.userMessages.isEmpty()) {
        Column(
            Modifier.fillMaxSize().padding(Spacing.xl).testTag("activity-empty"),
            verticalArrangement = Arrangement.spacedBy(Spacing.s, Alignment.CenterVertically),
            horizontalAlignment = Alignment.CenterHorizontally,
        ) {
            if (review.isWorking) CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp)
            Text(
                if (review.isWorking) "Waiting for output…" else "No logs recorded",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
            )
            ui.logsError?.let { Text(dev.optio.core.ui.state.ErrorText.humanize(it, "logs"), style = OptioTheme.type.caption, color = OptioTheme.colors.red) }
        }
        return
    }
    ReviewActivityList(ui.logs, ui.userMessages)
}

private sealed interface ActivityItem {
    val key: String
    val timestamp: String

    data class Log(val index: Int, val entry: AgentLogEntry) : ActivityItem {
        override val key get() = "log-$index"
        override val timestamp get() = entry.timestamp
    }

    data class User(val message: ReviewDetailViewModel.UserMessage) : ActivityItem {
        override val key get() = "user-${message.id}"
        override val timestamp get() = message.timestamp
    }
}

/** The transcript with your chat turns interleaved by time (iOS `ReviewActivityView`). */
@Composable
internal fun ReviewActivityList(
    entries: List<AgentLogEntry>,
    userMessages: List<ReviewDetailViewModel.UserMessage>,
    modifier: Modifier = Modifier,
    state: LazyListState = rememberLazyListState(),
) {
    val items = remember(entries, userMessages) {
        (entries.mapIndexed { i, e -> ActivityItem.Log(i, e) } + userMessages.map { ActivityItem.User(it) })
            .sortedBy { it.timestamp }
    }
    var previousCount by remember { mutableIntStateOf(0) }
    LaunchedEffect(items.size) {
        val count = items.size
        val previous = previousCount
        previousCount = count
        if (count == 0) return@LaunchedEffect
        val lastVisible = state.layoutInfo.visibleItemsInfo.lastOrNull()?.index ?: -1
        if (previous == 0 || lastVisible >= previous - 1) {
            if (previous == 0) state.scrollToItem(count - 1) else state.animateScrollToItem(count - 1)
        }
    }
    LazyColumn(
        state = state,
        modifier = modifier.fillMaxSize().testTag("review-activity"),
        contentPadding = PaddingValues(Spacing.l),
        verticalArrangement = Arrangement.spacedBy(10.dp),
    ) {
        items(items, key = { it.key }) { item ->
            when (item) {
                is ActivityItem.Log -> AgentLogRow(item.entry)
                is ActivityItem.User -> UserTurn(item.message)
            }
        }
    }
}

@Composable
private fun UserTurn(message: ReviewDetailViewModel.UserMessage) {
    val colors = OptioTheme.colors
    Column(Modifier.fillMaxWidth().padding(start = 40.dp), horizontalAlignment = Alignment.End, verticalArrangement = Arrangement.spacedBy(2.dp)) {
        SelectionContainer {
            Text(
                message.text,
                style = OptioTheme.type.body,
                color = colors.label,
                modifier = Modifier
                    .widthIn(max = 320.dp)
                    .background(colors.accent.copy(alpha = 0.15f), Radius.bubbleShape)
                    .padding(horizontal = Spacing.m, vertical = 10.dp),
            )
        }
        when (message.status) {
            ReviewDetailViewModel.UserMessage.Status.SENDING -> Text("Sending…", style = OptioTheme.type.caption2, color = colors.secondaryLabel)
            ReviewDetailViewModel.UserMessage.Status.FAILED -> Text("Failed to send", style = OptioTheme.type.caption2, color = colors.red)
            ReviewDetailViewModel.UserMessage.Status.SENT -> Unit
        }
    }
}

// endregion

// region Runs

@Composable
private fun RunsTab(runs: List<PrReviewRun>) {
    if (runs.isEmpty()) {
        Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
            EmptyState(title = "No runs yet", icon = Icons.Outlined.TripOrigin)
        }
        return
    }
    val now = rememberNow()
    LazyColumn(
        modifier = Modifier.fillMaxSize().readableWidth().testTag("review-runs"),
        contentPadding = PaddingValues(vertical = Spacing.s),
    ) {
        item {
            GroupedSection {
                runs.forEachIndexed { index, run ->
                    if (index > 0) InsetDivider()
                    RunRow(run, now)
                }
            }
        }
    }
}

@Composable
private fun RunRow(run: PrReviewRun, now: Instant) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("run-${run.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            StatusBadge(text = run.state, tone = Tone.forState(run.state))
            Text((run.kind ?: "run").capitalizedWords(), style = type.subheadline.medium(), color = colors.label, modifier = Modifier.weight(1f))
            (run.startedAt ?: run.createdAt)?.let {
                Text(it.relativeDescription(now), style = type.caption, color = colors.secondaryLabel)
            }
        }
        val duration = run.startedAt?.let { Durations.between(it, run.completedAt, now) }
        val cost = Cost.formatIfNonZero(run.costUsd)
        if (duration != null || run.modelUsed != null || cost != null) {
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
                duration?.let { RunFact(Icons.Outlined.Schedule, it) }
                run.modelUsed?.let { RunFact(Icons.Outlined.Memory, it) }
                cost?.let { RunFact(Icons.Outlined.AttachMoney, it) }
            }
        }
        run.resultSummary?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = type.caption, color = colors.label, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
        run.errorMessage?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = type.caption, color = colors.red, maxLines = 3, overflow = TextOverflow.Ellipsis)
        }
    }
}

@Composable
private fun RunFact(icon: androidx.compose.ui.graphics.vector.ImageVector, text: String) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(3.dp)) {
        Icon(icon, contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.size(13.dp))
        Text(text, style = OptioTheme.type.caption2, color = OptioTheme.colors.secondaryLabel, maxLines = 1)
    }
}

// endregion
