package dev.optio.feature.agents

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SheetState
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import kotlinx.coroutines.launch

/**
 * "New trigger" (iOS `AgentTriggerSheet`, widened to the seven trigger types the API takes for an
 * agent): a type picker, the type's fields, and Create. [onCreate] returns true when the server
 * accepted it; the sheet then closes.
 */
@Composable
internal fun AgentTriggerSheet(
    onDismiss: () -> Unit,
    onCreate: suspend (AgentTriggerDraft) -> Boolean,
    sheetState: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(AgentTriggerDraft()) }
    var saving by remember { mutableStateOf(false) }
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("trigger-sheet"),
    ) {
        AgentTriggerForm(
            draft = draft,
            onChange = { draft = it },
            saving = saving,
            onCancel = { scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() } },
            onCreate = {
                scope.launch {
                    saving = true
                    val created = onCreate(draft)
                    saving = false
                    if (created) {
                        sheetState.hide()
                        onDismiss()
                    }
                }
            },
        )
    }
}

/** The sheet's body, stateless (screenshots render it without a sheet). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun AgentTriggerForm(
    draft: AgentTriggerDraft,
    onChange: (AgentTriggerDraft) -> Unit,
    saving: Boolean,
    onCancel: () -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(horizontal = Spacing.l)
            .padding(bottom = Spacing.xl),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("trigger-cancel")) { Text("Cancel") }
            Text(
                "New trigger",
                style = OptioTheme.type.headline,
                color = colors.label,
                modifier = Modifier.weight(1f),
                textAlign = androidx.compose.ui.text.style.TextAlign.Center,
            )
            Button(
                onClick = onCreate,
                enabled = draft.isValid && !saving,
                modifier = Modifier.testTag("trigger-create"),
            ) { Text(if (saving) "Saving…" else "Create") }
        }

        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            AgentTriggerType.entries.forEach { type ->
                FilterChip(
                    selected = draft.type == type,
                    onClick = { onChange(draft.copy(type = type)) },
                    label = { Text(type.label) },
                    leadingIcon = { Icon(type.icon, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
                    modifier = Modifier.testTag("trigger-type-${type.raw}"),
                )
            }
        }

        when (draft.type) {
            AgentTriggerType.SCHEDULE -> ScheduleFields(draft, onChange)
            AgentTriggerType.WEBHOOK ->
                OutlinedTextField(
                    value = draft.webhookPath,
                    onValueChange = { onChange(draft.copy(webhookPath = it.trim())) },
                    label = { Text("Path") },
                    prefix = { Text("/api/hooks/", style = OptioTheme.type.body.mono(), color = colors.secondaryLabel) },
                    singleLine = true,
                    textStyle = OptioTheme.type.body.mono(),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Uri),
                    modifier = Modifier.fillMaxWidth().testTag("trigger-webhook-path"),
                )
            AgentTriggerType.TICKET -> TicketFields(draft, onChange)
            AgentTriggerType.GITHUB -> EventFields(draft, onChange, github = true)
            AgentTriggerType.LINEAR -> EventFields(draft, onChange, github = false)
            AgentTriggerType.SLACK -> SlackFields(draft, onChange)
            AgentTriggerType.MANUAL -> Unit
        }

        val problem = draft.validation
        Text(
            problem ?: draft.footer,
            style = OptioTheme.type.footnote,
            color = if (problem != null) colors.red else colors.secondaryLabel,
            modifier = Modifier.testTag("trigger-footer"),
        )
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleFields(draft: AgentTriggerDraft, onChange: (AgentTriggerDraft) -> Unit) {
    OutlinedTextField(
        value = draft.cron,
        onValueChange = { onChange(draft.copy(cron = it)) },
        label = { Text("Cron expression") },
        placeholder = { Text("0 9 * * 1-5") },
        singleLine = true,
        isError = !AgentTriggers.cronIsValid(draft.cron),
        textStyle = OptioTheme.type.body.mono(),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, keyboardType = KeyboardType.Ascii),
        modifier = Modifier.fillMaxWidth().testTag("trigger-cron"),
    )
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        AgentTriggers.cronPresets.forEach { (label, expr) ->
            FilterChip(
                selected = draft.cron.trim() == expr,
                onClick = { onChange(draft.copy(cron = expr)) },
                label = { Text(label) },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TicketFields(draft: AgentTriggerDraft, onChange: (AgentTriggerDraft) -> Unit) {
    var label by rememberSaveable { mutableStateOf("") }
    fun add() {
        val t = label.trim()
        if (t.isNotEmpty() && t !in draft.ticketLabels) onChange(draft.copy(ticketLabels = draft.ticketLabels + t))
        label = ""
    }
    FieldLabel("Source")
    FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        AgentTriggers.ticketSources.forEach { source ->
            FilterChip(
                selected = draft.ticketSource == source,
                onClick = { onChange(draft.copy(ticketSource = source)) },
                label = { Text(source.replaceFirstChar { it.titlecase() }) },
            )
        }
    }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
        OutlinedTextField(
            value = label,
            onValueChange = { label = it },
            label = { Text("Add a label") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { add() }),
            modifier = Modifier.weight(1f).testTag("trigger-label"),
        )
        TextButton(onClick = ::add, enabled = label.isNotBlank()) { Text("Add") }
    }
    if (draft.ticketLabels.isNotEmpty()) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            draft.ticketLabels.forEach { l ->
                InputChip(
                    selected = false,
                    onClick = { onChange(draft.copy(ticketLabels = draft.ticketLabels - l)) },
                    label = { Text(l) },
                    trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remove $l", modifier = Modifier.size(16.dp)) },
                )
            }
        }
    }
}

@Composable
private fun ColumnScope.EventFields(draft: AgentTriggerDraft, onChange: (AgentTriggerDraft) -> Unit, github: Boolean) {
    val kinds = if (github) AgentTriggers.githubKinds else AgentTriggers.linearKinds
    val events = if (github) draft.githubEvents else draft.linearEvents
    FieldLabel("Wake on")
    Column {
        kinds.forEach { kind ->
            SwitchRow(
                label = kind.label,
                checked = kind.value in events,
                onCheckedChange = { on ->
                    val next = if (on) events + kind.value else events - kind.value
                    onChange(if (github) draft.copy(githubEvents = next) else draft.copy(linearEvents = next))
                },
                tag = "event-${kind.value}",
            )
        }
    }
    if (draft.needsPerson) {
        OutlinedTextField(
            value = if (github) draft.githubLogin else draft.linearUser,
            onValueChange = { v ->
                val value = v.removePrefix("@")
                onChange(if (github) draft.copy(githubLogin = value) else draft.copy(linearUser = value))
            },
            label = { Text(if (github) "GitHub username" else "Linear user") },
            placeholder = { Text(if (github) "octocat" else "Jane Doe") },
            singleLine = true,
            textStyle = if (github) OptioTheme.type.body.mono() else OptioTheme.type.body,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().testTag("trigger-person"),
        )
    }
}

@Composable
private fun SlackFields(draft: AgentTriggerDraft, onChange: (AgentTriggerDraft) -> Unit) {
    OutlinedTextField(
        value = draft.slackChannel,
        onValueChange = { onChange(draft.copy(slackChannel = it.trim().uppercase())) },
        label = { Text("Channel id") },
        placeholder = { Text("C0123ABCD") },
        singleLine = true,
        textStyle = OptioTheme.type.body.mono(),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
        modifier = Modifier.fillMaxWidth().testTag("trigger-slack-channel"),
    )
    OutlinedTextField(
        value = draft.slackKeyword,
        onValueChange = { onChange(draft.copy(slackKeyword = it)) },
        label = { Text("Keyword (optional)") },
        singleLine = true,
        modifier = Modifier.fillMaxWidth(),
    )
    Column {
        SwitchRow("Only when @-mentioned", draft.slackMentionOnly, { onChange(draft.copy(slackMentionOnly = it)) }, tag = "slack-mention-only")
        SwitchRow("Include thread replies", draft.slackIncludeThreads, { onChange(draft.copy(slackIncludeThreads = it)) }, tag = "slack-threads")
    }
}

@Composable
private fun FieldLabel(text: String) {
    Text(text, style = OptioTheme.type.subheadline.semibold(), color = OptioTheme.colors.secondaryLabel)
}

@Composable
private fun SwitchRow(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    tag: String,
) {
    Row(
        Modifier.fillMaxWidth().padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onCheckedChange, modifier = Modifier.testTag(tag))
    }
}
