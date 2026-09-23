package dev.optio.feature.tasks.trigger

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.LinearScale
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.TouchApp
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.AssistChip
import androidx.compose.material3.Button
import androidx.compose.material3.FilterChip
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.MonoText
import dev.optio.core.ui.components.Truncation
import dev.optio.core.ui.components.copyToClipboard
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.tasks.common.FormPicker
import dev.optio.feature.tasks.common.FormSwitch
import dev.optio.feature.tasks.common.FormTextField
import dev.optio.feature.tasks.data.ScheduleFormat
import dev.optio.feature.tasks.data.TriggerDraft
import dev.optio.feature.tasks.data.TriggerKind
import dev.optio.feature.tasks.data.TriggerRow
import dev.optio.feature.tasks.data.TriggerText
import kotlinx.coroutines.launch

/** The symbol for a trigger type (iOS `triggerIcon` / `JobFormat.triggerIcon`). */
val TriggerKind.icon: ImageVector
    get() = when (this) {
        TriggerKind.MANUAL -> Icons.Outlined.TouchApp
        TriggerKind.SCHEDULE -> Icons.Outlined.Schedule
        TriggerKind.WEBHOOK -> Icons.Outlined.Webhook
        TriggerKind.TICKET -> Icons.Outlined.ConfirmationNumber
        TriggerKind.GITHUB -> Icons.Outlined.Code
        TriggerKind.SLACK -> Icons.Outlined.Tag
        TriggerKind.LINEAR -> Icons.Outlined.LinearScale
        TriggerKind.UNKNOWN -> Icons.Outlined.Bolt
    }

/**
 * One trigger (iOS `JobTriggerRow` + the scheduled page's trigger rows): its type, what fires it
 * (the cron in words, the copyable webhook URL, the ticket / event filters), next and last fire,
 * and, for people who may change things, an enable switch ([onToggle]) and Delete ([onDelete]).
 * Test tags: `trigger-<id>`, `trigger-switch-<id>`, `trigger-delete-<id>`, `trigger-copy-<id>`.
 */
@Composable
fun TriggerRowView(
    trigger: TriggerRow,
    baseUrl: String?,
    modifier: Modifier = Modifier,
    onToggle: ((Boolean) -> Unit)? = null,
    onDelete: (() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val now = LocalClock.current.instant()
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    Row(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("trigger-${trigger.id}"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Box(
            Modifier.size(32.dp).background(colors.fillTertiary, Radius.smallShape),
            contentAlignment = Alignment.Center,
        ) {
            Icon(trigger.kind.icon, contentDescription = null, tint = if (trigger.enabled) colors.label else colors.tertiaryLabel, modifier = Modifier.size(18.dp))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                Text(trigger.label, style = type.subheadline.semibold(), color = colors.label)
                if (!trigger.enabled) Text("Paused", style = type.footnote, color = colors.tertiaryLabel)
            }
            when (trigger.kind) {
                TriggerKind.SCHEDULE -> {
                    val cron = trigger.cronExpression.orEmpty()
                    val words = ScheduleFormat.cron(cron)
                    if (words != cron) Text(words, style = type.footnote, color = colors.secondaryLabel)
                    MonoText(cron, style = type.monoFootnote, color = colors.secondaryLabel)
                }
                TriggerKind.WEBHOOK -> trigger.webhookUrl(baseUrl)?.let { url ->
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        MonoText(url, style = type.monoFootnote, color = colors.secondaryLabel, truncation = Truncation.MIDDLE, modifier = Modifier.weight(1f))
                        IconButton(
                            onClick = {
                                scope.launch {
                                    copyToClipboard(clipboard, url)
                                    toaster.success("Webhook URL copied")
                                }
                            },
                            modifier = Modifier.size(32.dp).testTag("trigger-copy-${trigger.id}"),
                        ) {
                            Icon(Icons.Outlined.ContentCopy, contentDescription = "Copy webhook URL", tint = colors.secondaryLabel, modifier = Modifier.size(16.dp))
                        }
                    }
                    if (!trigger.webhookSecret.isNullOrEmpty()) Text("Signed (X-Optio-Signature)", style = type.caption, color = colors.tertiaryLabel)
                }
                else -> Text(trigger.summary, style = type.footnote, color = colors.secondaryLabel, maxLines = 3, overflow = TextOverflow.Ellipsis)
            }
            metaText(
                trigger.nextFireAt?.takeIf { trigger.enabled }?.let { "Next ${it.relativeDescription(now)}" },
                trigger.lastFiredAt?.let { "Last ${it.relativeDescription(now)}" },
                trigger.createdAt?.takeIf { trigger.lastFiredAt == null && trigger.nextFireAt == null }?.let { "Created ${it.relativeDescription(now)}" },
            )?.let { Text(it, style = type.caption, color = colors.tertiaryLabel) }
        }
        if (onToggle != null) {
            Switch(checked = trigger.enabled, onCheckedChange = onToggle, modifier = Modifier.testTag("trigger-switch-${trigger.id}"))
        }
        if (onDelete != null) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("trigger-delete-${trigger.id}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete ${trigger.label} trigger", tint = colors.secondaryLabel)
            }
        }
    }
}

/**
 * Edits one trigger of any of the seven types (iOS `JobFormView.triggerEditor`,
 * `TriggerFormSheet`, the work form's `EventRows`): type chips, then the type's fields with the
 * cron presets, the webhook URL preview, ticket filters and event checklists.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TriggerEditor(
    draft: TriggerDraft,
    onChange: (TriggerDraft) -> Unit,
    baseUrl: String?,
    modifier: Modifier = Modifier,
    kinds: List<TriggerKind> = TriggerKind.editable,
    showEnabled: Boolean = true,
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.m)) {
        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            kinds.forEach { kind ->
                FilterChip(
                    selected = draft.type == kind,
                    onClick = { onChange(draft.withType(kind)) },
                    label = { Text(kind.label) },
                    leadingIcon = { Icon(kind.icon, contentDescription = null, modifier = Modifier.size(16.dp)) },
                    modifier = Modifier.testTag("trigger-type-${kind.raw}"),
                )
            }
        }
        when (draft.type) {
            TriggerKind.MANUAL, TriggerKind.UNKNOWN -> Text(
                "Manual triggers only run when you start them.",
                style = type.footnote,
                color = colors.secondaryLabel,
            )
            TriggerKind.SCHEDULE -> {
                FormTextField(
                    value = draft.cron,
                    onValueChange = { onChange(draft.withString("cronExpression", it)) },
                    label = "Cron expression",
                    placeholder = "0 9 * * 1-5",
                    mono = true,
                    capitalization = KeyboardCapitalization.None,
                    supportingText = TriggerText.cronHint(draft.cron),
                    isError = !TriggerText.cronIsValid(draft.cron),
                    testTag = "trigger-cron",
                )
                Row(Modifier.horizontalScroll(rememberScrollState()), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    TriggerText.cronPresets.forEach { preset ->
                        AssistChip(
                            onClick = { onChange(draft.withString("cronExpression", preset.expr)) },
                            label = { Text(preset.label) },
                            modifier = Modifier.testTag("cron-preset-${preset.expr}"),
                        )
                    }
                }
            }
            TriggerKind.WEBHOOK -> {
                FormTextField(
                    value = draft.path,
                    onValueChange = { onChange(draft.withString("path", TriggerText.sanitizePath(it))) },
                    label = "Path",
                    placeholder = "my-workflow-hook",
                    mono = true,
                    prefix = "/api/hooks/",
                    capitalization = KeyboardCapitalization.None,
                    testTag = "trigger-path",
                )
                if (draft.path.isNotEmpty()) {
                    MonoText(TriggerText.hookUrl(baseUrl, draft.path), style = type.monoCaption, color = colors.secondaryLabel, truncation = Truncation.MIDDLE)
                }
                FormTextField(
                    value = draft.secret,
                    onValueChange = { onChange(draft.withString("secret", it)) },
                    label = "HMAC secret (optional)",
                    mono = true,
                    capitalization = KeyboardCapitalization.None,
                    supportingText = "POST to this URL to start a run; the JSON body becomes the {{params}}. With a secret, sign the body in X-Optio-Signature.",
                    testTag = "trigger-secret",
                )
            }
            TriggerKind.TICKET -> {
                FormPicker(
                    label = "Source",
                    selection = draft.ticketSource,
                    options = TriggerText.ticketSources.map { it to TriggerText.sourceLabel(it) },
                    onSelect = { onChange(draft.withString("source", it)) },
                    testTag = "trigger-source",
                )
                ListField(
                    initial = draft.strings("labels"),
                    label = "Labels (comma separated)",
                    supportingText = "Leave labels empty to accept all tickets from the source.",
                    onChange = { onChange(draft.withStrings("labels", it)) },
                    testTag = "trigger-labels",
                )
            }
            TriggerKind.GITHUB, TriggerKind.LINEAR -> {
                Text("Fires on", style = type.footnote, color = colors.secondaryLabel)
                draft.eventKinds.forEach { kind ->
                    FormSwitch(
                        label = kind.label,
                        checked = kind.value in draft.events,
                        onCheckedChange = { on -> onChange(draft.toggleEvent(kind.value, on)) },
                        testTag = "trigger-event-${kind.value}",
                    )
                }
                if (draft.events.isEmpty()) Text("None picked: every kind fires it.", style = type.caption, color = colors.tertiaryLabel)
                val personKey = draft.personKey
                if (personKey != null && draft.needsPerson) {
                    val github = draft.type == TriggerKind.GITHUB
                    FormTextField(
                        value = draft.string(personKey),
                        onValueChange = { v -> onChange(draft.withString(personKey, v.removePrefix("@"))) },
                        label = if (github) "GitHub username" else "Linear user",
                        placeholder = if (github) "octocat" else "Jane Doe",
                        mono = github,
                        capitalization = KeyboardCapitalization.None,
                        testTag = "trigger-person",
                    )
                }
                if (draft.type == TriggerKind.GITHUB) {
                    ListField(
                        initial = draft.strings("repos"),
                        label = "Repos (owner/name, comma separated)",
                        supportingText = "Empty: any repo (a scheduled Task listens to its own).",
                        onChange = { onChange(draft.withStrings("repos", it)) },
                        testTag = "trigger-repos",
                    )
                } else {
                    ListField(
                        initial = draft.strings("labels"),
                        label = "Labels (comma separated)",
                        supportingText = "Empty: any label.",
                        onChange = { onChange(draft.withStrings("labels", it)) },
                        testTag = "trigger-labels",
                    )
                    ListField(
                        initial = draft.strings("teams"),
                        label = "Teams (keys, comma separated)",
                        supportingText = "Empty: any team.",
                        onChange = { onChange(draft.withStrings("teams", it)) },
                        testTag = "trigger-teams",
                    )
                }
            }
            TriggerKind.SLACK -> {
                FormTextField(
                    value = draft.string("channelId"),
                    onValueChange = { onChange(draft.withString("channelId", it.trim())) },
                    label = "Channel id",
                    placeholder = "C0123ABCD",
                    mono = true,
                    capitalization = KeyboardCapitalization.Characters,
                    testTag = "trigger-channel",
                )
                FormSwitch(
                    label = "Only when @-mentioned",
                    checked = draft.bool("mentionOnly"),
                    onCheckedChange = { onChange(draft.withBool("mentionOnly", it)) },
                    testTag = "trigger-mention-only",
                )
                FormTextField(
                    value = draft.string("keyword"),
                    onValueChange = { onChange(draft.withString("keyword", it)) },
                    label = "Keyword (optional)",
                    capitalization = KeyboardCapitalization.None,
                    testTag = "trigger-keyword",
                )
                FormSwitch(
                    label = "Include thread replies",
                    checked = draft.bool("includeThreads"),
                    onCheckedChange = { onChange(draft.withBool("includeThreads", it)) },
                    testTag = "trigger-threads",
                )
            }
        }
        if (showEnabled) {
            FormSwitch(label = "Enabled", checked = draft.enabled, onCheckedChange = { onChange(draft.copy(enabled = it)) }, testTag = "trigger-enabled")
        }
        draft.problem?.takeIf { draft.type != TriggerKind.SCHEDULE }?.let {
            Text(it, style = type.footnote, color = colors.red, modifier = Modifier.testTag("trigger-problem"))
        }
    }
}

/** A comma-separated list field that keeps what's typed (a trailing comma) while it updates the list. */
@Composable
private fun ListField(
    initial: List<String>,
    label: String,
    onChange: (List<String>) -> Unit,
    supportingText: String? = null,
    testTag: String? = null,
) {
    var text by remember { mutableStateOf(initial.joinToString(", ")) }
    FormTextField(
        value = text,
        onValueChange = {
            text = it
            onChange(it.split(',').map(String::trim).filter(String::isNotEmpty).distinct())
        },
        label = label,
        capitalization = KeyboardCapitalization.None,
        supportingText = supportingText,
        testTag = testTag,
    )
}

/**
 * The Add trigger sheet (iOS `TriggerFormSheet`, web `trigger-selector.tsx`): the [TriggerEditor]
 * for a new trigger, Add / Cancel. [onAdd] saves it; an error stays in the sheet.
 */
@Composable
fun AddTriggerSheet(
    baseUrl: String?,
    onAdd: suspend (TriggerDraft) -> Unit,
    onDismiss: () -> Unit,
    initialKind: TriggerKind = TriggerKind.SCHEDULE,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(TriggerDraft.new(initialKind)) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.testTag("add-trigger-sheet")) {
        ProvideElevatedSurfaces {
            Column(
                Modifier
                    .fillMaxWidth()
                    .verticalScroll(rememberScrollState())
                    .padding(horizontal = Spacing.l)
                    .navigationBarsPadding(),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TextButton(onClick = onDismiss, enabled = !saving) { Text("Cancel") }
                    Text("Add trigger", style = OptioTheme.type.headline, color = OptioTheme.colors.label, modifier = Modifier.weight(1f).padding(horizontal = Spacing.s))
                    Button(
                        onClick = {
                            saving = true
                            error = null
                            scope.launch {
                                try {
                                    onAdd(draft)
                                    sheetState.hide()
                                    onDismiss()
                                } catch (e: kotlin.coroutines.cancellation.CancellationException) {
                                    throw e
                                } catch (e: Exception) {
                                    error = e
                                } finally {
                                    saving = false
                                }
                            }
                        },
                        enabled = !saving && draft.isValid,
                        modifier = Modifier.testTag("add-trigger-confirm"),
                    ) { Text(if (saving) "Adding…" else "Add") }
                }
                TriggerEditor(draft = draft, onChange = { draft = it }, baseUrl = baseUrl, showEnabled = false)
                error?.let { ErrorRow(it, contentPadding = androidx.compose.foundation.layout.PaddingValues(0.dp)) }
                Spacer(Modifier.height(Spacing.l))
            }
        }
    }
}
