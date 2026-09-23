package dev.optio.feature.local.automations

import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.local.model.EventKind
import dev.optio.feature.local.model.TriggerKind
import dev.optio.feature.local.model.Triggers
import java.util.UUID
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject

/**
 * Add trigger (iOS `AddTriggerSheet`, web `AddTriggerForm`): pick what starts the automation, fill
 * in that kind's config, and Add. Schedule, webhook and ticket as on iOS, plus the GitHub / Slack /
 * Linear event triggers the web offers. [serverUrl] shows where a webhook listens.
 */
@Composable
internal fun AddTriggerSheet(
    serverUrl: String?,
    onDismiss: () -> Unit,
    onSubmit: suspend (TriggerKind, JsonObject) -> Unit,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(Triggers.Draft(cron = "0 9 * * *", path = "local-" + UUID.randomUUID().toString().take(8))) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }

    fun submit() {
        val built = Triggers.build(draft)
        val config = built.getOrElse { problem ->
            error = problem.message
            return
        }
        saving = true
        error = null
        scope.launch {
            try {
                onSubmit(draft.kind, config)
                sheet.hide()
                onDismiss()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = ErrorText.humanize(e, "trigger")
            } finally {
                saving = false
            }
        }
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("add-trigger-sheet")) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .padding(horizontal = Spacing.l)
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            Text("Add trigger", style = OptioTheme.type.title3.semibold())
            Row(Modifier.fillMaxWidth().horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                TriggerKind.entries.forEach { kind ->
                    FilterChip(
                        selected = draft.kind == kind,
                        onClick = {
                            draft = draft.copy(kind = kind)
                            error = null
                        },
                        label = { Text(kind.label) },
                        leadingIcon = { Icon(kind.icon, contentDescription = null, modifier = Modifier.size(16.dp)) },
                        modifier = Modifier.testTag("trigger-kind-${kind.raw}"),
                    )
                }
            }
            when (draft.kind) {
                TriggerKind.SCHEDULE -> {
                    Field("Cron expression", draft.cron, { draft = draft.copy(cron = it) }, mono = true, tag = "trigger-cron")
                    Hint("Five space-separated fields: minute hour day month weekday (0 9 * * 1-5 = weekdays at 9:00).")
                }
                TriggerKind.WEBHOOK -> {
                    Field("Webhook path", draft.path, { draft = draft.copy(path = it) }, mono = true, tag = "trigger-path")
                    val path = draft.path.trim()
                    if (serverUrl != null && path.isNotEmpty()) {
                        Text("POST ${serverUrl.trimEnd('/')}/api/hooks/$path", style = OptioTheme.type.caption.mono(), color = OptioTheme.colors.secondaryLabel)
                    }
                }
                TriggerKind.TICKET -> {
                    SourcePicker(draft.source) { draft = draft.copy(source = it) }
                    Field("Labels, comma-separated (optional)", draft.labels, { draft = draft.copy(labels = it) })
                }
                TriggerKind.GITHUB -> {
                    EventChecks(Triggers.githubKinds, draft.githubEvents) { draft = draft.copy(githubEvents = it) }
                    Field("Your GitHub username", draft.githubLogin, { draft = draft.copy(githubLogin = it) }, mono = true, tag = "trigger-login")
                    Field("owner/repo, owner/other (optional)", draft.githubRepos, { draft = draft.copy(githubRepos = it) }, mono = true)
                    Hint(
                        "Add a repo or org webhook pointing at ${serverUrl?.trimEnd('/') ?: ""}/api/webhooks/github with the server's " +
                            "GITHUB_WEBHOOK_SECRET, subscribed to Pull requests, Issues, Issue comments, Pull request reviews and review comments.",
                    )
                }
                TriggerKind.SLACK -> {
                    Field("Channel id, e.g. C0123ABCD", draft.channelId, { draft = draft.copy(channelId = it) }, mono = true, capitalize = true, tag = "trigger-channel")
                    Field("Only when the message contains… (optional)", draft.keyword, { draft = draft.copy(keyword = it) })
                    Toggle("Only when the app is @-mentioned", draft.mentionOnly) { draft = draft.copy(mentionOnly = it) }
                    Toggle("Include thread replies", draft.includeThreads) { draft = draft.copy(includeThreads = it) }
                    Hint(
                        "In your Slack app, set the Event Subscriptions request URL to ${serverUrl?.trimEnd('/') ?: ""}/api/webhooks/slack/events, " +
                            "subscribe to message.channels (and app_mention for @-mentions), invite the app to the channel, and set SLACK_SIGNING_SECRET on the server.",
                    )
                }
                TriggerKind.LINEAR -> {
                    EventChecks(Triggers.linearKinds, draft.linearEvents) { draft = draft.copy(linearEvents = it) }
                    Field("Your Linear name, @handle, or user id", draft.linearUser, { draft = draft.copy(linearUser = it) })
                    Field("Team keys, e.g. ENG (optional)", draft.linearTeams, { draft = draft.copy(linearTeams = it) }, mono = true, capitalize = true)
                    Field("Labels (optional)", draft.labels, { draft = draft.copy(labels = it) })
                    Hint(
                        "In Linear → Settings → API → Webhooks, add ${serverUrl?.trimEnd('/') ?: ""}/api/webhooks/linear for Issues and Comments, " +
                            "and set LINEAR_WEBHOOK_SECRET on the server to the webhook's signing secret.",
                    )
                }
            }
            error?.let { Text(it, style = OptioTheme.type.footnote, color = OptioTheme.colors.red, modifier = Modifier.testTag("trigger-error")) }
            Row(Modifier.fillMaxWidth().padding(bottom = Spacing.l), horizontalArrangement = Arrangement.spacedBy(Spacing.s, Alignment.End)) {
                TextButton(onClick = onDismiss) { Text("Cancel") }
                Button(onClick = ::submit, enabled = !saving, modifier = Modifier.testTag("trigger-add")) {
                    if (saving) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("Add")
                }
            }
        }
    }
}

@Composable
private fun Field(
    label: String,
    value: String,
    onChange: (String) -> Unit,
    mono: Boolean = false,
    capitalize: Boolean = false,
    tag: String? = null,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onChange,
        label = { Text(label) },
        singleLine = true,
        textStyle = if (mono) OptioTheme.type.body.mono() else OptioTheme.type.body,
        keyboardOptions =
            KeyboardOptions(
                capitalization = if (capitalize) KeyboardCapitalization.Characters else KeyboardCapitalization.None,
                autoCorrectEnabled = false,
            ),
        modifier = Modifier.fillMaxWidth().then(if (tag != null) Modifier.testTag(tag) else Modifier),
    )
}

@Composable
private fun Hint(text: String) {
    Text(text, style = OptioTheme.type.caption, color = OptioTheme.colors.secondaryLabel)
}

@Composable
private fun Toggle(
    label: String,
    checked: Boolean,
    onChange: (Boolean) -> Unit,
) {
    Row(Modifier.fillMaxWidth().clickable { onChange(!checked) }, verticalAlignment = Alignment.CenterVertically) {
        Text(label, style = OptioTheme.type.body, modifier = Modifier.weight(1f))
        Switch(checked = checked, onCheckedChange = onChange)
    }
}

@Composable
private fun EventChecks(
    kinds: List<EventKind>,
    selected: Set<String>,
    onChange: (Set<String>) -> Unit,
) {
    Column {
        kinds.forEach { kind ->
            val on = kind.value in selected
            Row(
                Modifier.fillMaxWidth().clickable { onChange(if (on) selected - kind.value else selected + kind.value) }.testTag("event-${kind.value}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = on, onCheckedChange = { onChange(if (on) selected - kind.value else selected + kind.value) })
                Text(kind.label, style = OptioTheme.type.body)
            }
        }
    }
}

@Composable
private fun SourcePicker(
    source: String,
    onChange: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    ExposedDropdownMenuBox(expanded = open, onExpandedChange = { open = it }) {
        OutlinedTextField(
            value = source,
            onValueChange = {},
            readOnly = true,
            label = { Text("Source") },
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = open) },
            modifier = Modifier.fillMaxWidth().menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable),
        )
        ExposedDropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            Triggers.ticketSources.forEach { s ->
                DropdownMenuItem(text = { Text(s) }, onClick = {
                    onChange(s)
                    open = false
                })
            }
        }
    }
}
