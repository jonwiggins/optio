package dev.optio.feature.agents

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Edit
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.model.PersistentAgent
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.italic
import dev.optio.core.ui.theme.mono

/**
 * The agent's configuration (iOS `AgentConfigSection`): runtime, model, pod lifecycle and limits,
 * "Edit agent", then the system prompt, operator manual and initial prompt.
 */
@Composable
internal fun AgentConfigSection(
    agent: PersistentAgent?,
    onEdit: () -> Unit,
    modifier: Modifier = Modifier,
) {
    if (agent == null) {
        Column(modifier.fillMaxSize()) { SkeletonRows() }
        return
    }
    val canMutate = Roles.canMutate
    LazyColumn(
        modifier.fillMaxSize().testTag("agent-config"),
        contentPadding = PaddingValues(bottom = Spacing.xl),
    ) {
        item {
            GroupedSection(header = "Settings") {
                KeyValueRow("Runtime", agent.agentRuntime)
                InsetDivider()
                KeyValueRow("Model", agent.model?.takeIf { it.isNotEmpty() } ?: "default")
                InsetDivider()
                KeyValueRow("Pod lifecycle", agent.podLifecycle.raw.takeUnless { agent.podLifecycle.isUnknown } ?: "unknown")
                InsetDivider()
                KeyValueRow("Idle pod TTL", "${(agent.idlePodTimeoutMs / 1000).toInt()}s")
                InsetDivider()
                KeyValueRow("Max turn duration", "${(agent.maxTurnDurationMs / 1000).toInt()}s")
                InsetDivider()
                KeyValueRow("Max turns", "${agent.maxTurns.toInt()}")
                InsetDivider()
                KeyValueRow("Failure limit", "${agent.consecutiveFailureLimit.toInt()}")
                InsetDivider()
                KeyValueRow("Enabled", if (agent.enabled) "Yes" else "No")
                agent.branch?.let {
                    InsetDivider()
                    KeyValueRow("Branch", it, mono = true)
                }
                if (canMutate) {
                    InsetDivider()
                    EditRow(onEdit)
                }
            }
        }
        item { PromptBlock("System prompt", agent.systemPrompt) }
        item { PromptBlock("Operator manual (agents.md)", agent.agentsMd) }
        item { PromptBlock("Initial prompt", agent.initialPrompt) }
    }
}

@Composable
private fun EditRow(onEdit: () -> Unit) {
    val accent = OptioTheme.colors.accent
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(role = Role.Button, onClick = onEdit)
            .padding(horizontal = Spacing.l, vertical = Spacing.m)
            .testTag("edit-agent"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(Icons.Outlined.Edit, contentDescription = null, tint = accent, modifier = Modifier.size(18.dp))
        Text("Edit agent", style = OptioTheme.type.body, color = accent)
    }
}

/** A prompt as mono text, eight lines until "Show more" (iOS `PromptBlock`); "(empty)" when unset. */
@Composable
private fun PromptBlock(
    title: String,
    text: String?,
) {
    var expanded by rememberSaveable(title) { mutableStateOf(false) }
    val colors = OptioTheme.colors
    GroupedSection(header = title) {
        Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m)) {
            if (!text.isNullOrEmpty()) {
                SelectionContainer {
                    Text(
                        text,
                        style = OptioTheme.type.caption.mono(),
                        color = colors.label,
                        maxLines = if (expanded) Int.MAX_VALUE else 8,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
                if (text.length > 400) {
                    TextButton(onClick = { expanded = !expanded }, contentPadding = PaddingValues(0.dp)) {
                        Text(if (expanded) "Show less" else "Show more", style = OptioTheme.type.caption)
                    }
                }
            } else {
                Text("(empty)", style = OptioTheme.type.body.italic(), color = colors.secondaryLabel)
            }
        }
    }
}
