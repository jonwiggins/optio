package dev.optio.feature.widgets.config

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.selectable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.data.ServerProfile
import dev.optio.core.glance.RunTarget
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.components.ServerDot
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.widgets.run.rawId

/**
 * A configuration screen (widget setup, the Run tile's settings): a top bar with Close, a grouped
 * list, and the one primary button pinned at the bottom.
 */
@Composable
internal fun ConfigScreen(
    title: String,
    onClose: () -> Unit,
    primaryLabel: String,
    primaryEnabled: Boolean,
    onPrimary: () -> Unit,
    content: LazyListScope.() -> Unit,
) {
    Scaffold(
        containerColor = OptioTheme.colors.page,
        topBar = {
            TopAppBar(
                title = { Text(title) },
                navigationIcon = {
                    IconButton(onClick = onClose, modifier = Modifier.testTag("back")) { Icon(Icons.Filled.Close, contentDescription = "Close") }
                },
                colors = TopAppBarDefaults.topAppBarColors(containerColor = OptioTheme.colors.page),
            )
        },
        bottomBar = {
            Box(Modifier.fillMaxWidth().background(OptioTheme.colors.page).navigationBarsPadding().padding(horizontal = Spacing.l, vertical = Spacing.m)) {
                Button(onClick = onPrimary, enabled = primaryEnabled, modifier = Modifier.fillMaxWidth().testTag("config-save")) { Text(primaryLabel) }
            }
        },
    ) { padding ->
        LazyColumn(Modifier.fillMaxSize(), contentPadding = PaddingValues(top = padding.calculateTopPadding(), bottom = padding.calculateBottomPadding() + Spacing.l), content = content)
    }
}

/**
 * One option of a single-choice list (iOS: a picker row and its checkmark): the whole row selects,
 * the chosen one carries a trailing check. Centred vertically, whether or not it has a meta line.
 */
@Composable
internal fun ChoiceRow(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    meta: AnnotatedString? = null,
    leading: (@Composable () -> Unit)? = null,
) {
    val type = OptioTheme.type
    val colors = OptioTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .selectable(selected = selected, role = Role.RadioButton, onClick = onClick)
            .padding(OptioRowDefaults.ContentPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        leading?.invoke()
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(title, style = type.body, color = colors.label, maxLines = 2, overflow = TextOverflow.Ellipsis)
            if (meta != null) Text(meta, style = type.subheadline, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
        }
        Icon(
            Icons.Filled.Check,
            contentDescription = null,
            tint = if (selected) colors.accent else Color.Transparent,
            modifier = Modifier.size(20.dp),
        )
    }
}

/** A toggle row. */
@Composable
internal fun ToggleRow(
    title: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    meta: AnnotatedString? = null,
) {
    OptioRow(
        title = title,
        meta = meta,
        modifier = modifier,
        onClick = { onChange(!checked) },
        trailingContent = { Switch(checked = checked, onCheckedChange = onChange) },
    )
}

/** The Server option: every paired server (the default), or one of them. */
internal fun LazyListScope.serverChoices(
    servers: List<ServerProfile>,
    selection: String?,
    onSelect: (String?) -> Unit,
) {
    item(key = "servers") {
        GroupedSection(header = "Server", footer = "Every paired server shows each row with its server's coloured dot. Choose one to show only it.") {
            ChoiceRow(
                title = "All servers",
                meta = metaText(if (servers.size == 1) "1 paired server" else "${servers.size} paired servers"),
                selected = selection == null,
                onClick = { onSelect(null) },
                modifier = Modifier.testTag("server-all"),
            )
            servers.forEach { server ->
                InsetDivider()
                ChoiceRow(
                    title = server.name,
                    meta = metaText(server.host),
                    selected = selection == server.id,
                    onClick = { onSelect(server.id) },
                    leading = { ServerDot(argb = server.color.argb) },
                    modifier = Modifier.testTag("server-${server.id}"),
                )
            }
        }
    }
}

/**
 * The run targets on every paired server, blueprints first (iOS `RunTargetQuery` suggestions),
 * each with its kind and, when several servers are paired, its server.
 */
internal fun LazyListScope.targetChoices(
    state: LoadState<List<RunTarget>>,
    selection: String?,
    onSelect: (RunTarget) -> Unit,
    onRetry: () -> Unit,
) {
    val targets = state.value
    when {
        targets == null && state is LoadState.Failed ->
            item(key = "error") { ErrorRow(state.error, what = "blueprints and Jobs", retry = onRetry) }
        targets == null -> item(key = "loading") { Box(Modifier.padding(top = Spacing.l)) { SkeletonRows(count = 4) } }
        targets.isEmpty() ->
            item(key = "empty") {
                EmptyState(
                    title = "Nothing to run",
                    message = "Create a Local automation or a Job in Optio, then pick it here.",
                )
            }
        else -> {
            val groups = listOf("Local blueprints" to RunTarget.Kind.LOCAL, "Jobs" to RunTarget.Kind.JOB)
            groups.forEach { (header, kind) ->
                val rows = targets.filter { it.kind == kind }
                if (rows.isEmpty()) return@forEach
                item(key = "targets-${kind.name.lowercase()}") {
                    GroupedSection(header = header) {
                        rows.forEachIndexed { index, target ->
                            if (index > 0) InsetDivider()
                            ChoiceRow(
                                title = target.name,
                                meta = metaText(target.serverName, target.spawnMode?.let { if (it == "auto") "starts immediately" else "held until you start it" }),
                                selected = selection == target.id,
                                onClick = { onSelect(target) },
                                modifier = Modifier.testTag("target-${target.rawId}"),
                            )
                        }
                    }
                }
            }
        }
    }
}

/** Signed out: nothing to configure until a server is paired. */
internal fun LazyListScope.signedOut(onOpenApp: () -> Unit) {
    item(key = "signed-out") {
        EmptyState(
            title = "Sign in to Optio",
            message = "Pair a server in the app first; the widgets and tiles use the same servers.",
            actionTitle = "Open Optio",
            action = onOpenApp,
            modifier = Modifier.padding(top = 24.dp),
        )
    }
}
