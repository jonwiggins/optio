package dev.optio.core.ui.triggers

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.MonoText
import dev.optio.core.ui.components.Truncation
import dev.optio.core.ui.components.copyToClipboard
import dev.optio.core.ui.form.CardNote
import dev.optio.core.ui.form.CheckRow
import dev.optio.core.ui.form.MenuChoice
import dev.optio.core.ui.form.MenuRow
import dev.optio.core.ui.form.RowDivider
import dev.optio.core.ui.form.SwitchRow
import dev.optio.core.ui.form.ValueField
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

// The one trigger editor (the New work form's When section, iOS `WhenSection`): the rows a trigger
// type needs, over a [TriggerDraft]. A Local automation's Add trigger sheet and a persistent agent's
// New trigger sheet draw the same rows under a type picker ([TriggerTypeChips]); the work form draws
// them under its Starts menu. Test tags take a [tagPrefix] (`work-form-cron`, `trigger-cron`).

/**
 * The rows for the picked type (nothing for [WhenType.MANUAL]): the cron and its presets, the
 * webhook path, the ticket source and labels, or the event's kinds, identity, filters and notes.
 * Every row sits under a hairline ([RowDivider]) like the rows of a form card.
 */
@Composable
fun TriggerRows(
    draft: TriggerDraft,
    onChange: (TriggerDraft) -> Unit,
    modifier: Modifier = Modifier,
    tagPrefix: String = "work-form",
) {
    Column(modifier.fillMaxWidth()) {
        when (draft.whenType) {
            WhenType.MANUAL -> Unit
            WhenType.SCHEDULE -> ScheduleRows(draft, onChange, tagPrefix)
            WhenType.WEBHOOK -> {
                RowDivider()
                ValueField(
                    label = "Path",
                    value = draft.trigger.webhookPath.orEmpty(),
                    onValueChange = { onChange(draft.copy(trigger = draft.trigger.copy(webhookPath = it.trim()))) },
                    placeholder = "hook-abc123",
                    prefix = "/api/hooks/",
                    keyboardType = KeyboardType.Uri,
                    fieldTag = "$tagPrefix-webhook",
                )
            }
            WhenType.TICKET -> TicketRows(draft, onChange, tagPrefix)
            else -> EventRows(draft, onChange, tagPrefix)
        }
    }
}

/** The trigger types as chips (the sheets' picker; iOS `AgentTriggerSheet`), each with its mark. */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TriggerTypeChips(
    selected: WhenType,
    onSelect: (WhenType) -> Unit,
    modifier: Modifier = Modifier,
    types: List<WhenType> = WhenType.forSheet(),
    tagPrefix: String = "trigger-type",
) {
    FlowRow(modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
        types.forEach { type ->
            FilterChip(
                selected = selected == type,
                onClick = { onSelect(type) },
                label = { Text(type.typeLabel) },
                leadingIcon = { Icon(type.rowIcon, contentDescription = null, modifier = Modifier.size(FilterChipDefaults.IconSize)) },
                modifier = Modifier.testTag("$tagPrefix-${type.raw}"),
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun ScheduleRows(draft: TriggerDraft, onChange: (TriggerDraft) -> Unit, tagPrefix: String) {
    fun set(expr: String) = onChange(draft.copy(trigger = draft.trigger.copy(cronExpression = expr)))
    RowDivider()
    ValueField(
        label = "Cron",
        value = draft.trigger.cronExpression.orEmpty(),
        onValueChange = ::set,
        placeholder = "0 9 * * *",
        fieldTag = "$tagPrefix-cron",
    )
    FlowRow(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        CRON_PRESETS.forEach { preset ->
            FilterChip(
                selected = draft.trigger.cronExpression?.trim() == preset.expr,
                onClick = { set(preset.expr) },
                label = { Text(preset.label, style = OptioTheme.type.footnote) },
            )
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TicketRows(draft: TriggerDraft, onChange: (TriggerDraft) -> Unit, tagPrefix: String) {
    val colors = OptioTheme.colors
    val source = draft.trigger.ticketSource ?: TicketSource.GITHUB
    val labels = draft.trigger.ticketLabels.orEmpty()
    var input by remember { mutableStateOf("") }
    val add = {
        val t = input.trim()
        if (t.isNotEmpty() && t !in labels) onChange(draft.copy(trigger = draft.trigger.copy(ticketLabels = labels + t)))
        input = ""
    }
    RowDivider()
    MenuRow(label = "Source", value = source.label, leadingIcon = source.icon, modifier = Modifier.testTag("$tagPrefix-ticket-source")) {
        TicketSource.entries.forEach { s ->
            MenuChoice(s.label, selected = s == source, icon = s.icon, onClick = { onChange(draft.copy(trigger = draft.trigger.copy(ticketSource = s))) })
        }
    }
    RowDivider()
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val style = OptioTheme.type.body.copy(color = colors.label)
        BasicTextField(
            value = input,
            onValueChange = { input = it },
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
            keyboardActions = KeyboardActions(onDone = { add() }),
            modifier = Modifier.weight(1f).padding(vertical = Spacing.m).semantics { contentDescription = "Add a label" }.testTag("$tagPrefix-label-input"),
            decorationBox = { inner ->
                if (input.isEmpty()) Text("Add a label", style = style.copy(color = colors.tertiaryLabel))
                inner()
            },
        )
        TextButton(onClick = add, enabled = input.isNotBlank(), modifier = Modifier.testTag("$tagPrefix-label-add")) {
            Text("Add", style = OptioTheme.type.body.semibold())
        }
    }
    if (labels.isNotEmpty()) {
        FlowRow(
            Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            labels.forEach { l ->
                InputChip(
                    selected = false,
                    onClick = { onChange(draft.copy(trigger = draft.trigger.copy(ticketLabels = labels - l))) },
                    label = { Text(l, style = OptioTheme.type.footnote) },
                    trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remove $l", modifier = Modifier.size(InputChipDefaults.IconSize)) },
                    colors = InputChipDefaults.inputChipColors(containerColor = colors.fillTertiary),
                    border = null,
                )
            }
        }
    }
}

/**
 * Event-trigger config (GitHub events + login + repos, Slack channel + keyword + mention-only +
 * threads, Linear events + user + teams + labels, …), in the shape the trigger routes store.
 */
@Composable
private fun EventRows(draft: TriggerDraft, onChange: (TriggerDraft) -> Unit, tagPrefix: String) {
    val type = draft.whenType.event ?: return
    val config = draft.event.config
    fun set(key: String, value: kotlinx.serialization.json.JsonElement) = onChange(draft.copy(event = EventTrigger(type, config.with(key, value))))
    fun clear(key: String) = onChange(draft.copy(event = EventTrigger(type, config.without(key))))
    if (type == EventTriggerType.SLACK) {
        RowDivider()
        ValueField(
            label = "Channel",
            value = config.string("channelId"),
            onValueChange = { set("channelId", JsonPrimitive(it.trim().uppercase())) },
            placeholder = "C0123ABCD",
            capitalization = KeyboardCapitalization.Characters,
            fieldTag = "$tagPrefix-channel",
        )
        RowDivider()
        ValueField(
            label = "Keyword",
            value = config.string("keyword"),
            onValueChange = { set("keyword", JsonPrimitive(it)) },
            placeholder = "Optional",
            mono = false,
            keyboardType = KeyboardType.Text,
            fieldTag = "$tagPrefix-keyword",
        )
        RowDivider()
        SwitchRow("Only when @-mentioned", checked = config.bool("mentionOnly"), onCheckedChange = { set("mentionOnly", JsonPrimitive(it)) }, modifier = Modifier.testTag("$tagPrefix-mention-only"))
        RowDivider()
        SwitchRow("Include thread replies", checked = config.bool("includeThreads"), onCheckedChange = { set("includeThreads", JsonPrimitive(it)) }, modifier = Modifier.testTag("$tagPrefix-threads"))
        return
    }
    val events = eventsOf(config)
    val kinds = eventKinds(type)
    if (kinds.isNotEmpty()) RowDivider()
    kinds.forEach { k ->
        CheckRow(
            k.label,
            checked = k.value in events,
            onToggle = { set("events", JsonArray((if (k.value in events) events - k.value else events + k.value).map(::JsonPrimitive))) },
            modifier = Modifier.testTag("$tagPrefix-event-${k.value}"),
        )
    }
    // Linear: skip tickets you created and changes you made yourself.
    val othersOnly = type == EventTriggerType.LINEAR && config.bool("othersOnly")
    if (type == EventTriggerType.LINEAR) {
        RowDivider()
        SwitchRow(
            "Only tickets from someone else",
            checked = othersOnly,
            onCheckedChange = { set("othersOnly", JsonPrimitive(it)) },
            modifier = Modifier.testTag("$tagPrefix-others-only"),
        )
        CardNote("Skips tickets you created and changes you made yourself, like assigning a ticket to yourself.")
    }
    val personal = kinds.any { it.personal && it.value in events } || othersOnly
    if (personal) {
        val key = identityKey(type)
        // GitHub and GitLab take a handle; Linear and Jira a name, handle, id or email.
        val handle = type == EventTriggerType.GITHUB || type == EventTriggerType.GITLAB
        RowDivider()
        ValueField(
            label = when (type) {
                EventTriggerType.GITHUB -> "GitHub username"
                EventTriggerType.GITLAB -> "GitLab username"
                EventTriggerType.JIRA -> "Jira user"
                else -> "Linear user"
            },
            value = config.string(key),
            onValueChange = { v -> set(key, JsonPrimitive(v.removePrefix("@"))) },
            placeholder = if (handle) "octocat" else "Ada Lovelace",
            mono = handle,
            capitalization = if (handle) KeyboardCapitalization.None else KeyboardCapitalization.Words,
            keyboardType = if (handle) KeyboardType.Ascii else KeyboardType.Text,
            fieldTag = "$tagPrefix-identity",
        )
        CardNote(
            when (type) {
                EventTriggerType.GITHUB, EventTriggerType.GITLAB -> "Whose review requests, assignments and mentions count as “about you”."
                EventTriggerType.JIRA -> "Whose assignments and mentions count as “about you”: a Jira account id, display name or email."
                else -> "Whose assignments and mentions count as “about you”: a Linear name, handle or user id."
            },
        )
    }
    eventFilters(type).forEach { filter ->
        RowDivider()
        ListField(draft, filter, tagPrefix) { set(filter.key, it) }
    }
    if (type == EventTriggerType.PAGERDUTY) {
        RowDivider()
        val urgency = config.string("urgency").ifEmpty { "any" }
        MenuRow(label = "Urgency", value = urgency.replaceFirstChar { it.uppercase() }, modifier = Modifier.testTag("$tagPrefix-urgency")) {
            listOf("any" to "Any", "high" to "High", "low" to "Low").forEach { (v, label) ->
                MenuChoice(label, selected = v == urgency, onClick = { if (v == "any") clear("urgency") else set("urgency", JsonPrimitive(v)) })
            }
        }
    }
    if (type.selfSecret) {
        CardNote(selfSecretNote(type))
    }
}

/** How a self-secret source is pointed at its trigger (the note under the rows, and the secret dialog's instructions). */
fun selfSecretNote(type: EventTriggerType): String = when (type) {
    EventTriggerType.PYLON -> "Pylon posts to this trigger's own URL with the header X-Optio-Secret. The URL and the secret are made when you save and shown once right after."
    EventTriggerType.ALERTMANAGER -> "Point an Alertmanager webhook_config (or a Grafana Webhook contact point with an Authorization header) at this trigger's own URL; the secret goes as a Bearer token or basic-auth password. Both are made when you save and shown once right after."
    EventTriggerType.DATADOG -> "In Datadog → Integrations → Webhooks, add this trigger's own URL with a custom header X-Optio-Secret and Optio's payload template, then @webhook-<name> in the monitor's message. The URL and the secret are made when you save and shown once right after."
    else -> ""
}

/**
 * A comma-separated filter (repos, teams, labels): the text is kept as typed so a comma can be
 * typed, and the config gets the parsed list on every change.
 */
@Composable
private fun ListField(draft: TriggerDraft, filter: EventFilter, tagPrefix: String, onSet: (JsonArray) -> Unit) {
    val type = draft.event.type
    var raw by remember(type, filter.key) { mutableStateOf(draft.event.config.strings(filter.key).joinToString(", ")) }
    ValueField(
        label = filter.label,
        value = raw,
        onValueChange = { text ->
            raw = text
            onSet(JsonArray(text.split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::JsonPrimitive)))
        },
        placeholder = filter.placeholder,
        mono = false,
        keyboardType = KeyboardType.Text,
        fieldTag = "$tagPrefix-filter-${filter.key}",
    )
}

/**
 * What a Pylon / Alertmanager / Datadog trigger needs you to paste into the sending service, shown
 * once, right after the trigger is created (iOS `TriggerSecretDialog`, the web's one secret
 * dialog): its own URL and its shared secret, each with a copy button, and how to use them.
 */
@Composable
fun TriggerSecretDialog(
    type: EventTriggerType,
    url: String,
    secret: String,
    onDismiss: () -> Unit,
) {
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("trigger-secret-dialog"),
        title = { Text("${WhenType.fromRaw(type.raw)?.typeLabel ?: type.raw} trigger created") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
                Text(
                    "Copy these now — the secret is shown only once. ${selfSecretNote(type).substringBefore(" The URL and the secret").substringBefore(" Both are made")}",
                    style = OptioTheme.type.footnote,
                    color = OptioTheme.colors.secondaryLabel,
                )
                SecretValue("URL", url, "trigger-secret-url") {
                    scope.launch {
                        copyToClipboard(clipboard, url)
                        toaster.success("URL copied")
                    }
                }
                SecretValue("Secret", secret, "trigger-secret-value") {
                    scope.launch {
                        copyToClipboard(clipboard, secret)
                        toaster.success("Secret copied")
                    }
                }
            }
        },
        confirmButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("trigger-secret-done")) { Text("Done") } },
    )
}

@Composable
private fun SecretValue(label: String, value: String, tag: String, onCopy: () -> Unit) {
    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
        Text(label, style = OptioTheme.type.caption.semibold(), color = OptioTheme.colors.secondaryLabel)
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            MonoText(
                text = value,
                style = OptioTheme.type.monoFootnote,
                color = OptioTheme.colors.label,
                truncation = Truncation.MIDDLE,
                maxLines = 2,
                modifier = Modifier.weight(1f).testTag(tag),
            )
            IconButton(onClick = onCopy, modifier = Modifier.size(32.dp).testTag("$tag-copy")) {
                Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy $label", modifier = Modifier.size(16.dp))
            }
        }
    }
}
