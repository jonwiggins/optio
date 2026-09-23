package dev.optio.feature.agents

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.DeleteOutline
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import dev.optio.core.model.stringValue
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.MonoText
import dev.optio.core.ui.components.PullRefresh
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.copyToClipboard
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import java.time.Instant
import kotlinx.coroutines.launch

/**
 * What wakes the agent besides messages (iOS `AgentTriggersSection`): one row per trigger with its
 * summary and next / last firing, delete per row, and "Add trigger" for any of the seven types. A
 * webhook row copies its full URL.
 */
@Composable
internal fun AgentTriggersSection(
    triggers: LoadState<List<PersistentAgentTrigger>>,
    onRefresh: suspend () -> Unit,
    onAdd: () -> Unit,
    onDelete: (PersistentAgentTrigger) -> Unit,
    modifier: Modifier = Modifier,
) {
    val list = triggers.value
    val now = rememberNow()
    val canMutate = Roles.canMutate
    val scope = rememberCoroutineScope()
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val baseUrl = LocalApiClient.current.baseUrl?.toString()?.removeSuffix("/")
    PullRefresh(onRefresh = onRefresh, modifier = modifier) {
        LazyColumn(Modifier.fillMaxSize().testTag("agent-triggers")) {
            when {
                list == null && triggers is LoadState.Failed ->
                    item { ErrorRow(error = triggers.error, what = "triggers", retry = { scope.launch { onRefresh() } }) }
                list == null -> item { SkeletonRows(count = 2) }
                list.isEmpty() ->
                    item {
                        Text(
                            "No triggers. Add a schedule, a webhook or an event to wake this agent automatically.",
                            style = OptioTheme.type.footnote,
                            color = OptioTheme.colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                    }
            }
            itemsIndexed(list.orEmpty(), key = { _, trigger -> trigger.id }) { index, trigger ->
                val path = trigger.config?.get("path")?.stringValue
                val copyUrl =
                    if (trigger.kind == AgentTriggerType.WEBHOOK && path != null && baseUrl != null) {
                        {
                            scope.launch {
                                copyToClipboard(clipboard, baseUrl + AgentTriggers.webhookPath(path))
                                toaster.success("Webhook URL copied")
                            }
                            Unit
                        }
                    } else {
                        null
                    }
                AgentTriggerRow(
                    trigger = trigger,
                    now = now,
                    onClick = copyUrl,
                    onDelete = if (canMutate) ({ onDelete(trigger) }) else null,
                )
                if (index < list.orEmpty().lastIndex) InsetDivider(start = 52.dp)
            }
            if (canMutate && list != null) {
                item(key = "add") {
                    if (list.isNotEmpty()) InsetDivider()
                    AddTriggerRow(onAdd)
                }
            }
        }
    }
}

@Composable
internal fun AgentTriggerRow(
    trigger: PersistentAgentTrigger,
    now: Instant,
    onClick: (() -> Unit)?,
    onDelete: (() -> Unit)?,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val clickable = if (onClick != null) Modifier.clickable(role = Role.Button, onClickLabel = "Copy webhook URL", onClick = onClick) else Modifier
    Row(
        modifier
            .fillMaxWidth()
            .then(clickable)
            .padding(start = Spacing.l, end = if (onDelete != null) Spacing.xs else Spacing.l, top = Spacing.m, bottom = Spacing.m)
            .testTag("trigger-${trigger.id}"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(trigger.kind.icon, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(20.dp))
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Text(trigger.kind?.label ?: trigger.type, style = OptioTheme.type.subheadline.semibold(), color = colors.label)
                if (trigger.enabled == false) StatusBadge(text = "disabled", tone = Tone.IDLE)
            }
            MonoText(trigger.summary, style = OptioTheme.type.monoCaption, color = colors.secondaryLabel, maxLines = 2)
            val timing =
                listOfNotNull(
                    trigger.nextFireAt?.let { "Next ${it.relativeDescription(now)}" },
                    trigger.lastFiredAt?.let { "Last ${it.sinceDescription(now)}" },
                )
            if (timing.isNotEmpty()) {
                Text(timing.joinToString("   "), style = OptioTheme.type.caption2, color = colors.secondaryLabel)
            }
        }
        if (onDelete != null) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("delete-trigger")) {
                Icon(Icons.Outlined.DeleteOutline, contentDescription = "Delete trigger", tint = colors.secondaryLabel)
            }
        }
    }
}

@Composable
private fun AddTriggerRow(onAdd: () -> Unit) {
    val accent = OptioTheme.colors.accent
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onAdd)
            .padding(horizontal = Spacing.l, vertical = Spacing.m + 2.dp)
            .testTag("add-trigger"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(Icons.Outlined.Add, contentDescription = null, tint = accent, modifier = Modifier.size(20.dp))
        Text("Add trigger", style = OptioTheme.type.body, color = accent)
    }
}

/** The glyph for a trigger type (iOS SF Symbols: calendar, link, ticket, …). */
internal val AgentTriggerType?.icon: ImageVector
    get() =
        when (this) {
            AgentTriggerType.SCHEDULE -> Icons.Outlined.Schedule
            AgentTriggerType.WEBHOOK -> Icons.Outlined.Webhook
            AgentTriggerType.TICKET -> Icons.Outlined.ConfirmationNumber
            AgentTriggerType.GITHUB -> Icons.Outlined.Code
            AgentTriggerType.SLACK -> Icons.Outlined.Tag
            AgentTriggerType.LINEAR -> Icons.Outlined.Bolt
            AgentTriggerType.MANUAL, null -> Icons.Outlined.TouchApp
        }
