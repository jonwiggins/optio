package dev.optio.feature.overview

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.calculateEndPadding
import androidx.compose.foundation.layout.calculateStartPadding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.AutoAwesome
import androidx.compose.material.icons.outlined.Checklist
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import androidx.navigation3.runtime.NavKey
import dev.optio.core.data.ServerProfile
import dev.optio.core.model.LocalTerminal
import dev.optio.core.navigation.Section
import dev.optio.core.navigation.WorkView
import dev.optio.core.navigation.routes.LocalTerminalRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.SkeletonStrip
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.format.Cost
import dev.optio.core.ui.format.InsightsFormat
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.usage.LimitsPanel
import dev.optio.core.ui.usage.LocalUsageStore
import dev.optio.core.ui.usage.UsageTokenBanners
import dev.optio.core.workfeed.WorkCounts
import dev.optio.core.workfeed.WorkFeed
import dev.optio.core.workfeed.WorkFeedModel

/** The active server as the Overview's card shows it. */
internal data class ActiveServer(
    val profile: ServerProfile,
    /** The signed-in user's name or email; null while unknown. */
    val userLabel: String?,
    val switching: Boolean,
    val serverCount: Int,
)

/** What the Overview's controls do; the screen wires them to the navigator, session and model. */
internal class OverviewActions(
    val onRefresh: suspend () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onRetryFeed: () -> Unit = {},
    val onOpenWork: (WorkView) -> Unit = {},
    val onOpenSection: (Section) -> Unit = {},
    val onOpen: (NavKey) -> Unit = {},
    val onOpenExternal: (String) -> Unit = {},
    /** Null hides every "New work" entry (viewers are read-only). */
    val onNewWork: (() -> Unit)? = {},
    val onManageServers: () -> Unit = {},
    val onSwitchServer: (String) -> Unit = {},
)

/**
 * The Overview, top to bottom (iOS `OverviewView`, a mirror of the web's `app/page.tsx`): the
 * counts line, the active server, what needs you, usage limits, the Work board, token banners, the
 * cluster, recent tasks, and the other paired servers. A skeleton on the first load, an error when
 * nothing could be loaded, a welcome on a truly empty install. Pulls to refresh.
 */
@Composable
internal fun OverviewContent(
    dashboard: OverviewDashboard,
    feed: WorkFeedModel.State,
    server: ActiveServer?,
    otherServers: List<ServerGlance>,
    contentPadding: PaddingValues,
    actions: OverviewActions,
    modifier: Modifier = Modifier,
) {
    val layoutDirection = LocalLayoutDirection.current
    val listPadding = PaddingValues(
        start = contentPadding.calculateStartPadding(layoutDirection),
        end = contentPadding.calculateEndPadding(layoutDirection),
        bottom = contentPadding.calculateBottomPadding() + Spacing.xl,
    )
    PullRefresh(onRefresh = actions.onRefresh, modifier = modifier.padding(top = contentPadding.calculateTopPadding())) {
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("overview-list"), contentPadding = listPadding) {
            when {
                dashboard.loading && dashboard.taskStats == null -> loading()
                // Nothing could be loaded at all (iOS would show the welcome; the error is truer).
                dashboard.taskStats == null && dashboard.error != null && dashboard.isFirstRun -> item(key = "error") {
                    ErrorRow(error = dashboard.error, what = "the overview", retry = actions.onRetry, modifier = Modifier.padding(top = Spacing.s))
                }
                dashboard.isFirstRun -> item(key = "welcome") { Welcome(dashboard.repoCount, actions.onNewWork) }
                else -> content(dashboard, feed, server, otherServers, actions)
            }
        }
    }
}

private fun LazyListScope.loading() {
    item(key = "loading") {
        Column(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xl)) {
            SkeletonStrip(labels = BoardTileLabels)
            Box(Modifier.clip(Radius.cardShape).background(OptioTheme.colors.card)) { SkeletonRows() }
        }
    }
}

private fun LazyListScope.content(
    dashboard: OverviewDashboard,
    feed: WorkFeedModel.State,
    server: ActiveServer?,
    otherServers: List<ServerGlance>,
    actions: OverviewActions,
) {
    item(key = "subtitle", contentType = "subtitle") { Subtitle(feed.counts) }
    if (server != null) {
        item(key = "active-server", contentType = "server") {
            ActiveServerCard(
                server = server.profile,
                userLabel = server.userLabel,
                switching = server.switching,
                serverCount = server.serverCount,
                hostsOnline = if (dashboard.hasLocal) dashboard.localHostsOnline else null,
                hostsTotal = if (dashboard.hasLocal) dashboard.localHosts.size else null,
                onClick = actions.onManageServers,
                modifier = Modifier.padding(horizontal = Spacing.l),
            )
        }
    }
    dashboard.error?.let { error ->
        item(key = "dashboard-error", contentType = "error") {
            ErrorRow(error = error, what = "the overview", retry = actions.onRetry, modifier = Modifier.padding(horizontal = Spacing.l))
        }
    }

    needsYou(dashboard, actions)

    item(key = "limits", contentType = "limits") {
        // Renders nothing until a provider has numbers (then the card, like iOS's conditional section).
        val store = LocalUsageStore.current
        if (store?.providerLimits?.isNotEmpty() == true) {
            LimitsPanel(Modifier.padding(horizontal = Spacing.l).padding(top = Spacing.l), store = store)
        }
    }

    workBoard(
        feed = feed,
        onOpenView = actions.onOpenWork,
        onOpenRow = { row -> actions.onOpen(row.destination.route()) },
        onOpenPr = actions.onOpenExternal,
        onNewWork = actions.onNewWork,
        onRetry = actions.onRetryFeed,
    )

    item(key = "token-banners", contentType = "banners") {
        val usage = LocalUsageStore.current?.usage
        if (usage != null && (usage.claudeAuthFailed || usage.githubAuthFailed)) {
            UsageTokenBanners(Modifier.padding(horizontal = Spacing.l).padding(top = Spacing.l))
        }
    }

    if (dashboard.clusterForbidden || dashboard.cluster != null) {
        sectionHeader(
            key = "cluster-header",
            title = "Cluster",
            action = if (dashboard.clusterForbidden) null else ({ actions.onOpenSection(Section.CLUSTER) }),
        )
        item(key = "cluster", contentType = "cluster") {
            ClusterSummaryCard(
                cluster = dashboard.cluster,
                forbidden = dashboard.clusterForbidden,
                totalCost = dashboard.totalRecentCost,
                history = dashboard.metricsHistory,
                modifier = Modifier.padding(horizontal = Spacing.l),
            )
        }
    }

    sectionHeader(key = "recent-header", title = "Recent", action = { actions.onOpenWork(WorkView.HISTORY) })
    if (dashboard.recentTasks.isEmpty()) {
        item(key = "recent-empty") {
            EmptyState(
                title = "No tasks yet",
                icon = Icons.Outlined.Checklist,
                message = "Start work that opens a PR in one of your repos.",
                actionTitle = if (actions.onNewWork != null) "New work" else null,
                action = actions.onNewWork,
            )
        }
    } else {
        groupedRows("recent", dashboard.recentTasks, key = { it.id }) { task ->
            RecentTaskRow(task) { actions.onOpen(TaskDetailRoute(task.id)) }
        }
    }

    if (otherServers.isNotEmpty()) {
        sectionHeader(key = "servers-header", title = "Other servers", detail = "${otherServers.size}")
        groupedRows("server", otherServers, key = { it.server.id }) { glance ->
            OtherServerRow(glance, onSwitch = { actions.onSwitchServer(glance.server.id) })
        }
        item(key = "servers-footer") {
            Text(
                "Tap to switch. Counts are fetched straight from each server.",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.padding(start = Spacing.l + Spacing.l, end = Spacing.l + Spacing.l, top = Spacing.s),
            )
        }
    }
}

/**
 * The web's first section: everything waiting on you, whatever it is (`needs-you.tsx`): Local
 * terminals waiting (oldest first, up to four) and tasks needing attention (up to three). Nothing
 * when nothing waits.
 */
private fun LazyListScope.needsYou(
    dashboard: OverviewDashboard,
    actions: OverviewActions,
) {
    val terminals = dashboard.localNeedsYou
    val tasks = dashboard.attentionTasks
    if (terminals.isEmpty() && tasks.isEmpty()) return
    sectionHeader(
        key = "needs-you-header",
        title = "Needs you",
        detail = "${terminals.size + tasks.size}",
        tone = Tone.ACCENT,
        action = { actions.onOpenWork(WorkView.ACTIVE) },
    )
    val hostNames = dashboard.localHostName
    val showHost = dashboard.localHosts.size > 1
    val rows = terminals.take(4).map(NeedsYouItem::Terminal) + tasks.take(3).map(NeedsYouItem::Task)
    groupedRows("needs-you", rows, key = { it.key }) { row ->
        when (row) {
            is NeedsYouItem.Task -> AttentionTaskRow(row.task) { actions.onOpen(TaskDetailRoute(row.task.id)) }
            is NeedsYouItem.Terminal -> TerminalRow(
                terminal = row.terminal,
                hostName = if (showHost) hostNames[row.terminal.hostId] else null,
                onClick = { actions.onOpen(LocalTerminalRoute(row.terminal.id)) },
            )
        }
    }
    if (terminals.size > 4) {
        item(key = "needs-you-more") {
            Text(
                "${terminals.size - 4} more waiting in Work",
                style = OptioTheme.type.footnote,
                color = OptioTheme.colors.accent,
                modifier = Modifier
                    .padding(start = Spacing.l + Spacing.l, top = Spacing.s)
                    .clickable(role = Role.Button) { actions.onOpenWork(WorkView.ACTIVE) }
                    .testTag("needs-you-more"),
            )
        }
    }
}

/** One row of the Needs-you section: a Local terminal or a task. */
private sealed interface NeedsYouItem {
    val key: String

    data class Terminal(val terminal: LocalTerminal) : NeedsYouItem {
        override val key: String
            get() = "terminal-${terminal.id}"
    }

    data class Task(val task: DashRecentTask) : NeedsYouItem {
        override val key: String
            get() = "task-${task.id}"
    }
}

/** A task waiting on you (iOS: `OptioRow` with the accent dot, repo · branch, the reason trailing). */
@Composable
private fun AttentionTaskRow(
    task: DashRecentTask,
    onClick: () -> Unit,
) {
    OptioRow(
        title = task.title ?: "Task ${task.id.take(8)}",
        tone = Tone.ACCENT,
        meta = metaText(InsightsFormat.repoShortName(task.repoUrl.orEmpty()), task.repoBranch?.let(::mono)),
        titleMaxLines = 1,
        trailingContent = { TrailingLabel(task.errorMessage ?: "needs attention", Tone.ACCENT) },
        onClick = onClick,
    )
}

/** A recent task (iOS `RecentTaskRow`, web `recent-tasks.tsx`): its state as a word or its age. */
@Composable
private fun RecentTaskRow(
    task: DashRecentTask,
    onClick: () -> Unit,
) {
    val now = rememberNow()
    val (trailing, tone) = when (task.state) {
        "completed" -> "Done" to null
        "failed" -> "Failed" to Tone.DANGER
        "needs_attention" -> "Needs you" to Tone.ACCENT
        "cancelled" -> "Cancelled" to null
        else -> task.createdAt?.relativeDescription(now).orEmpty() to null
    }
    OptioRow(
        title = task.title ?: "Untitled",
        tone = Tone.forState(task.state),
        meta = metaText(
            task.repoUrl?.let(InsightsFormat::repoShortName),
            task.agentType?.let(WorkFeed::runtimeLabel),
            Cost.formatIfNonZero(task.cost),
        ),
        trailing = trailing.ifEmpty { null },
        trailingTone = tone,
        onClick = onClick,
    )
}

/**
 * "N running · N waiting for you · N need you · N recurring" (the web page's subtitle; the iOS 26
 * navigation subtitle): waiting in green, needs-you in the accent.
 */
@Composable
private fun Subtitle(c: WorkCounts) {
    val colors = OptioTheme.colors
    val dot = SpanStyle(color = colors.tertiaryLabel)
    val text = buildAnnotatedString {
        append("${c.running} running")
        if (c.waiting > 0) {
            withStyle(dot) { append(" · ") }
            withStyle(SpanStyle(color = Tone.SUCCESS.textColor)) { append("${c.waiting} waiting for you") }
        }
        if (c.needsYou > 0) {
            withStyle(dot) { append(" · ") }
            withStyle(SpanStyle(color = Tone.ACCENT.textColor)) { append("${c.needsYou} need${if (c.needsYou == 1) "s" else ""} you") }
        }
        if (c.recurring > 0) {
            withStyle(dot) { append(" · ") }
            append("${c.recurring} recurring")
        }
    }
    Text(
        text,
        style = OptioTheme.type.subheadline,
        color = colors.secondaryLabel,
        modifier = Modifier.padding(start = Spacing.l + Spacing.xs, end = Spacing.l, bottom = Spacing.m).testTag("overview-subtitle"),
    )
}

/** `welcome-hero.tsx`: a truly empty install (no tasks, no Local terminals). */
@Composable
private fun Welcome(
    repoCount: Int?,
    onNewWork: (() -> Unit)?,
) {
    val colors = OptioTheme.colors
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.xl).testTag("overview-welcome"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.l),
    ) {
        Spacer(Modifier.height(Spacing.xl))
        Icon(Icons.Outlined.AutoAwesome, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(44.dp))
        Text("Welcome to Optio", style = OptioTheme.type.title2.semibold(), color = colors.label)
        Text(
            if (repoCount == 0) {
                "Add a repository or pair a machine, then start your first work to get an AI agent going."
            } else {
                "${repoCount ?: 0} ${if (repoCount == 1) "repo" else "repos"} connected. Start something."
            },
            style = OptioTheme.type.body,
            color = colors.secondaryLabel,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 360.dp),
        )
        if (onNewWork != null) {
            Button(
                onClick = onNewWork,
                colors = ButtonDefaults.buttonColors(containerColor = colors.label, contentColor = colors.page),
                modifier = Modifier.testTag("welcome-new-work"),
            ) { Text("New work") }
        }
        UsageTokenBanners()
    }
}
