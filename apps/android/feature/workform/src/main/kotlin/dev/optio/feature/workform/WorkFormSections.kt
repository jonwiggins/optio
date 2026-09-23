package dev.optio.feature.workform

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Logout
import androidx.compose.material.icons.automirrored.outlined.MenuBook
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material.icons.outlined.Code
import androidx.compose.material.icons.outlined.ConfirmationNumber
import androidx.compose.material.icons.outlined.Dns
import androidx.compose.material.icons.outlined.Forum
import androidx.compose.material.icons.outlined.Laptop
import androidx.compose.material.icons.outlined.Link
import androidx.compose.material.icons.automirrored.outlined.MergeType
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Schedule
import androidx.compose.material.icons.outlined.Tag
import androidx.compose.material.icons.outlined.Terminal
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextRange
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.OptioIcons
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonPrimitive

// The six sections of `work-form.tsx` (iOS `WorkFormSections.swift`), one card each. They read the
// state's draft and derived facts and write through its setters, so every change is normalized
// (upstream answers win). The contextual copy lives in each section's footer.

internal val WhenType.icon: ImageVector
    get() = when (this) {
        WhenType.MANUAL -> Icons.Outlined.PlayArrow
        WhenType.SCHEDULE -> Icons.Outlined.Schedule
        WhenType.WEBHOOK -> Icons.Outlined.Webhook
        WhenType.TICKET -> Icons.Outlined.ConfirmationNumber
        WhenType.GITHUB -> Icons.Outlined.Code
        WhenType.SLACK -> Icons.Outlined.Tag
        WhenType.LINEAR -> Icons.Outlined.Bolt
    }

internal fun presetIcon(id: String): ImageVector = when (id) {
    "pr" -> Icons.AutoMirrored.Outlined.MergeType
    "chat" -> Icons.Outlined.Forum
    "terminal" -> Icons.Outlined.Terminal
    "schedule" -> Icons.Outlined.Schedule
    else -> OptioIcons.Bot
}

internal fun thenIcon(then: Then): ImageVector = when (then) {
    Then.EXITS -> Icons.AutoMirrored.Outlined.Logout
    Then.WAITS_FOR_ME -> Icons.Outlined.Terminal
    Then.WAITS_FOR_MESSAGES -> OptioIcons.Bot
}

private fun runtimeName(runtime: String) = if (runtime == TERMINAL) "Terminal" else runtimeLabel(runtime)

// region Presets

/** Examples that fill the form in: a row of chips, not a setting. */
@Composable
internal fun PresetsSection(state: WorkFormState, modifier: Modifier = Modifier) {
    Column(modifier.fillMaxWidth()) {
        SectionHeader(
            "Start from an example",
            contentPadding = PaddingValues(start = Spacing.l + Spacing.l, end = Spacing.l, top = Spacing.m, bottom = 0.dp),
        )
        FormChipRow(
            chips = PRESETS.map { FormChip(it.id, it.label, presetIcon(it.id)) },
            selection = state.preset,
            onSelect = state::applyPreset,
            contentPadding = PaddingValues(horizontal = Spacing.l + Spacing.xs, vertical = Spacing.s),
            modifier = Modifier.testTag("work-form-presets"),
        )
    }
}

// endregion

// region When

@Composable
internal fun WhenSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    FormSectionCard(title = "When", question = "What starts it?", footer = whenFooter(d), modifier = modifier.testTag("work-form-when")) {
        MenuRow(label = "Starts", value = d.whenType.menuLabel, modifier = Modifier.testTag("work-form-starts")) {
            WhenType.entries.forEach { w ->
                val reason = state.whenDisabled(w)?.takeIf { w != d.whenType }
                MenuChoice(
                    w.menuLabel,
                    selected = w == d.whenType,
                    icon = w.icon,
                    enabled = reason == null,
                    subtitle = reason,
                    onClick = { state.setWhen(w) },
                )
            }
        }
        when (d.whenType) {
            WhenType.MANUAL -> Unit
            WhenType.SCHEDULE -> {
                RowDivider()
                ValueField(
                    label = "Cron",
                    value = d.trigger.cronExpression.orEmpty(),
                    onValueChange = state::setCron,
                    placeholder = "0 9 * * *",
                    fieldTag = "work-form-cron",
                )
                FormChipRow(
                    chips = CRON_PRESETS.map { FormChip(it.expr, it.label) },
                    selection = d.trigger.cronExpression,
                    onSelect = state::setCron,
                    contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
                )
            }
            WhenType.WEBHOOK -> {
                RowDivider()
                ValueField(
                    label = "Path",
                    value = d.trigger.webhookPath.orEmpty(),
                    onValueChange = state::setWebhookPath,
                    placeholder = "hook-abc123",
                    prefix = "/api/hooks/",
                    fieldTag = "work-form-webhook",
                )
            }
            WhenType.TICKET -> TicketRows(state)
            WhenType.GITHUB, WhenType.SLACK, WhenType.LINEAR -> EventRows(state)
        }
    }
}

private fun whenFooter(d: WorkDraft): String? = when (d.whenType) {
    WhenType.MANUAL -> null
    WhenType.SCHEDULE -> {
        val cron = d.trigger.cronExpression.orEmpty()
        when {
            !cronIsValid(cron) -> "Expected five space-separated fields."
            CRON_WORDS[cron.trim()] != null -> "Runs ${CRON_WORDS[cron.trim()]}."
            else -> "Five-field cron expression, in UTC."
        }
    }
    WhenType.WEBHOOK -> "POST to this path to start a run. The path must be unique across the workspace."
    WhenType.TICKET -> "Only tickets with at least one matching label start a run. No labels matches every ticket from the source."
    else -> "Each firing starts one run — in a pod or on your machine, whichever you pick below — with the event's fields available as {{param}}s."
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun TicketRows(state: WorkFormState) {
    val colors = OptioTheme.colors
    val source = state.draft.trigger.ticketSource ?: TicketSource.GITHUB
    val labels = state.draft.trigger.ticketLabels.orEmpty()
    var input by remember { mutableStateOf("") }
    val add = {
        state.addTicketLabel(input)
        input = ""
    }
    RowDivider()
    MenuRow(label = "Source", value = source.label) {
        TicketSource.entries.forEach { s -> MenuChoice(s.label, selected = s == source, onClick = { state.setTicketSource(s) }) }
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
            modifier = Modifier.weight(1f).padding(vertical = Spacing.m).semantics { contentDescription = "Add a label" }.testTag("work-form-label-input"),
            decorationBox = { inner ->
                if (input.isEmpty()) Text("Add a label", style = style.copy(color = colors.tertiaryLabel))
                inner()
            },
        )
        TextButton(onClick = add, enabled = input.isNotBlank()) { Text("Add", style = OptioTheme.type.body.semibold()) }
    }
    if (labels.isNotEmpty()) {
        FlowRow(
            Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            labels.forEach { l ->
                InputChip(
                    selected = false,
                    onClick = { state.removeTicketLabel(l) },
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
 * threads, Linear events + user + teams + labels), in the shape the trigger routes store.
 */
@Composable
private fun EventRows(state: WorkFormState) {
    val type = state.draft.whenType.event ?: return
    val config = state.draft.event.config
    if (type == EventTriggerType.SLACK) {
        RowDivider()
        ValueField(
            label = "Channel",
            value = config.string("channelId"),
            onValueChange = { state.setEventField("channelId", JsonPrimitive(it.trim())) },
            placeholder = "C0123ABCD",
            capitalization = KeyboardCapitalization.Characters,
            fieldTag = "work-form-channel",
        )
        RowDivider()
        ValueField(
            label = "Keyword",
            value = config.string("keyword"),
            onValueChange = { state.setEventField("keyword", JsonPrimitive(it)) },
            placeholder = "Optional",
            mono = false,
        )
        RowDivider()
        SwitchRow("Only when @-mentioned", checked = config.bool("mentionOnly"), onCheckedChange = { state.setEventField("mentionOnly", JsonPrimitive(it)) })
        RowDivider()
        SwitchRow("Include thread replies", checked = config.bool("includeThreads"), onCheckedChange = { state.setEventField("includeThreads", JsonPrimitive(it)) })
        return
    }
    val events = eventsOf(config)
    val kinds = eventKinds(type)
    RowDivider()
    kinds.forEach { k -> CheckRow(k.label, checked = k.value in events, onToggle = { state.toggleEventKind(k.value) }) }
    val personal = kinds.any { it.personal && it.value in events }
    if (personal) {
        val key = identityKey(type)
        RowDivider()
        ValueField(
            label = if (type == EventTriggerType.GITHUB) "GitHub username" else "Linear user",
            value = config.string(key),
            onValueChange = { v -> state.setEventField(key, JsonPrimitive(v.removePrefix("@"))) },
            placeholder = if (type == EventTriggerType.GITHUB) "octocat" else "Ada Lovelace",
            mono = type == EventTriggerType.GITHUB,
            capitalization = if (type == EventTriggerType.GITHUB) KeyboardCapitalization.None else KeyboardCapitalization.Words,
            keyboardType = if (type == EventTriggerType.GITHUB) androidx.compose.ui.text.input.KeyboardType.Ascii else androidx.compose.ui.text.input.KeyboardType.Text,
            fieldTag = "work-form-identity",
        )
        CardNote(
            if (type == EventTriggerType.GITHUB) {
                "Whose review requests, assignments and mentions count as “about you”."
            } else {
                "Whose assignments and mentions count as “about you”: a Linear name, handle or user id."
            },
        )
    }
    RowDivider()
    if (type == EventTriggerType.GITHUB) {
        ListField(state, "repos", "Only these repos", "owner/name, owner/other")
    } else {
        ListField(state, "teams", "Only these teams", "ENG, OPS")
        RowDivider()
        ListField(state, "labels", "Only with a label", "bug, triage")
    }
}

/**
 * A comma-separated filter (repos, teams, labels): the text is kept as typed so a comma can be
 * typed, and the config gets the parsed list on every change.
 */
@Composable
private fun ListField(state: WorkFormState, key: String, label: String, placeholder: String) {
    val type = state.draft.event.type
    var raw by remember(type, key) { mutableStateOf(state.draft.event.config.strings(key).joinToString(", ")) }
    ValueField(
        label = label,
        value = raw,
        onValueChange = { text ->
            raw = text
            state.setEventField(key, JsonArray(text.split(',').map { it.trim() }.filter { it.isNotEmpty() }.map(::JsonPrimitive)))
        },
        placeholder = placeholder,
        mono = false,
        fieldTag = "work-form-filter-$key",
    )
}

// endregion

// region Where

@Composable
internal fun WhereSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    FormSectionCard(title = "Where", question = "A pod, or your machine?", footer = whereFooter(state), modifier = modifier.testTag("work-form-where")) {
        ChoiceRow(
            icon = Icons.Outlined.Dns,
            title = "Optio pod",
            subtitle = if (d.withRepo) "Clones one of your repos into a fresh worktree" else "Isolated, no checkout, with the server's Connections",
            selected = !state.isLocal,
            disabled = state.podDisabled.takeIf { state.isLocal },
            onClick = { state.setWhere(Where.CLUSTER) },
            modifier = Modifier.testTag("work-form-where-pod"),
        )
        RowDivider(start = 56.dp)
        ChoiceRow(
            icon = Icons.Outlined.Laptop,
            title = "My machine",
            subtitle = "A paired machine, with your own agent CLI and login",
            selected = state.isLocal,
            disabled = state.machineDisabled.takeIf { !state.isLocal },
            onClick = { state.setWhere(Where.LOCAL) },
            modifier = Modifier.testTag("work-form-where-machine"),
        )
        RowDivider()
        if (state.isLocal) MachineRows(state) else PodRows(state)
    }
}

private fun whereFooter(state: WorkFormState): String? {
    val d = state.draft
    if (state.isLocal) {
        val dirs = state.dirs
        if (state.host?.state == dev.optio.core.model.LocalHostState.OFFLINE) {
            return "This machine is offline — runs wait in the queue until it reconnects."
        }
        if (dirs.isNotEmpty() && d.withRepo && dirs.none { it.repoUrl != null }) {
            return "None of this machine's directories is a git checkout — add one with `optio local add <checkout>`, or work in the current directory."
        }
        if (d.withRepo) {
            val repo = state.localRepoUrl
            return if (repo != null) {
                "Branches off ${d.repoBranch.ifEmpty { "the base branch" }} in ${shortRepo(repo)} and opens a PR against it."
            } else {
                "The agent branches off the base branch in the checkout and opens a PR against it."
            }
        }
        return "Works in the directory as it is, on whatever branch is checked out. Nothing is pushed unless you or the agent do it."
    }
    if (!d.withRepo) return "No checkout — results are logs and side effects through Connections."
    if (!state.reposLoading && state.repos.isEmpty()) return "No repos configured. Add one under Library › Repos, or pick My machine."
    return null
}

/** A machine: host and directory, then "Current directory | New branch". */
@Composable
private fun MachineRows(state: WorkFormState) {
    val d = state.draft
    val host = state.host
    val dirs = state.dirs
    MenuRow(
        label = "Machine",
        value = host?.let { if (it.state == dev.optio.core.model.LocalHostState.OFFLINE) "${it.name} (offline)" else it.name } ?: "Pick a machine…",
        placeholder = host == null,
        modifier = Modifier.testTag("work-form-machine"),
    ) {
        state.hosts.forEach { h ->
            MenuChoice(
                h.name,
                selected = h.id == d.location.localHostId,
                subtitle = if (h.state == dev.optio.core.model.LocalHostState.OFFLINE) "Offline" else null,
                onClick = { state.setHost(h.id) },
            )
        }
    }
    RowDivider()
    MenuRow(
        label = if (d.withRepo) "Checkout" else "Directory",
        value = if (d.location.localDir.isEmpty()) {
            when {
                dirs.isEmpty() -> "No directories"
                d.withRepo -> "Pick a checkout…"
                else -> "Pick a directory…"
            }
        } else {
            shortDir(d.location.localDir)
        },
        placeholder = d.location.localDir.isEmpty(),
        mono = true,
        modifier = Modifier.testTag("work-form-dir"),
    ) {
        if (dirs.isEmpty()) MenuCaption("Run `optio local add <dir>` on this machine.")
        dirs.forEach { dir ->
            val usable = state.usableDir(dir)
            MenuChoice(
                shortDir(dir.path),
                selected = dir.path == d.location.localDir,
                subtitle = if (usable) null else "Not a git checkout",
                enabled = usable,
                mono = true,
                onClick = { state.setDir(dir.path) },
            )
        }
    }
    RowDivider()
    SegmentedRow(
        options = listOf(false to "Current directory", true to "New branch"),
        selection = d.withRepo,
        onSelect = state::setWithRepo,
        disabled = state::withRepoDisabled,
    )
    if (d.withRepo) {
        RowDivider()
        ValueField(label = "Base branch", value = d.repoBranch, onValueChange = state::setBranch, placeholder = "main", fieldTag = "work-form-branch")
    }
    LockNote(state)
}

/** A pod: "A repository | No repo", then the repo and its branch. */
@Composable
private fun PodRows(state: WorkFormState) {
    val d = state.draft
    SegmentedRow(
        options = listOf(true to "A repository", false to "No repo"),
        selection = d.withRepo,
        onSelect = state::setWithRepo,
        disabled = state::withRepoDisabled,
    )
    if (d.withRepo) {
        RowDivider()
        val repo = state.repoRow
        MenuRow(
            label = "Repository",
            value = when {
                state.reposLoading && state.repos.isEmpty() -> "Loading…"
                repo != null -> repo.fullName
                state.repos.isEmpty() -> "None"
                else -> "Pick a repo…"
            },
            placeholder = repo == null,
            modifier = Modifier.testTag("work-form-repo"),
        ) {
            state.repos.forEach { r ->
                MenuChoice(r.fullName, selected = r.id == d.repoId, subtitle = r.defaultBranch, onClick = { state.setRepo(r.id) })
            }
        }
        RowDivider()
        ValueField(label = "Branch", value = d.repoBranch, onValueChange = state::setBranch, placeholder = "main", fieldTag = "work-form-branch")
    }
    LockNote(state)
}

/** Editing: why the other "with a repo" answer is off (it would move the row to another table). */
@Composable
private fun LockNote(state: WorkFormState) {
    val reason = state.withRepoDisabled(!state.draft.withRepo) ?: return
    CardNote(reason)
}

// endregion

// region Who

@Composable
internal fun WhoSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    val runtimes = state.runtimeChoices
    FormSectionCard(title = "Who", question = "A terminal, or an agent?", footer = whoFooter(state, runtimes), modifier = modifier.testTag("work-form-who")) {
        MenuRow(label = "Runtime", value = runtimeName(d.runtime), modifier = Modifier.testTag("work-form-runtime")) {
            runtimes.forEach { r ->
                MenuChoice(
                    runtimeName(r.value),
                    selected = r.value == d.runtime,
                    icon = if (r.value == TERMINAL) Icons.Outlined.Terminal else OptioIcons.Bot,
                    enabled = r.isEnabled,
                    subtitle = r.disabled,
                    onClick = { state.setRuntime(r.value) },
                )
            }
        }
        if (!state.isTerminal && state.kind != WorkKind.POD_SESSION) {
            RowDivider()
            AgentOptionsPicker(
                provider = state.provider,
                state = state.catalogState,
                values = d.agentOptions,
                modelOnly = !state.fullOptionsApply,
                onChange = state::setOption,
            )
        }
    }
}

private fun whoFooter(state: WorkFormState, runtimes: List<Choice<String>>): String {
    val lines = mutableListOf<String>()
    lines += when {
        state.isTerminal -> "Just you at a shell prompt — no agent, no prompt."
        state.kind == WorkKind.POD_SESSION ->
            "A pod session opens a terminal and a Claude Code chat side by side — you type the first message there."
        state.isLocal -> "Uses the CLI and login already on the machine; only the model is set here."
        state.draft.withRepo -> "Runs with the server's credentials. Parameters start from the repo's defaults and apply to this run only."
        else -> "Runs with the server's credentials. Blank means the runtime's default."
    }
    // One clause per reason (the web lists every disabled runtime under the first one's reason,
    // which misreads when Terminal and the pod-only CLIs are off for different reasons).
    runtimes.filter { !it.isEnabled }.groupBy { it.disabled.orEmpty() }.forEach { (reason, off) ->
        lines += "${off.joinToString(", ") { runtimeName(it.value) }} — ${reason.removeSuffix(".")}."
    }
    if (!state.isTerminal && state.kind != WorkKind.POD_SESSION) catalogFootnote(state.catalogState)?.let { lines += it }
    return lines.joinToString(" ")
}

// endregion

// region What

/**
 * [value] kept in step with [text]: the caret survives typing, and an outside change (a saved
 * prompt, a preset) replaces the text with the caret at its end.
 */
internal fun synced(value: TextFieldValue, text: String): TextFieldValue =
    if (value.text == text) value else TextFieldValue(text, TextRange(text.length))

/** [value] with [token] replacing its selection, the caret after it. */
internal fun inserting(value: TextFieldValue, token: String): TextFieldValue {
    val start = minOf(value.selection.start, value.selection.end).coerceIn(0, value.text.length)
    val end = maxOf(value.selection.start, value.selection.end).coerceIn(0, value.text.length)
    val text = value.text.replaceRange(start, end, token)
    return TextFieldValue(text, TextRange(start + token.length))
}

@Composable
internal fun WhatSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    var field by remember { mutableStateOf(TextFieldValue(d.prompt, TextRange(d.prompt.length))) }
    val shown = synced(field, d.prompt)
    val focus = remember { FocusRequester() }
    val placeholder = when {
        d.whenType == WhenType.TICKET || d.whenType == WhenType.LINEAR -> "{{ticketUrl}}, please triage this ticket."
        d.whenType == WhenType.GITHUB -> "Review {{url}} and leave comments on anything risky."
        d.then == Then.WAITS_FOR_MESSAGES -> "Who this agent is and what it should do on its first turn."
        d.withRepo -> "Describe the change. Be specific about files to modify and expected behavior."
        else -> "Describe what the agent should do. Reference Connections for external systems."
    }
    FormSectionCard(
        title = "What",
        question = if (d.then == Then.WAITS_FOR_MESSAGES) "The first prompt" else "The prompt",
        footer = whatFooter(state),
        modifier = modifier.testTag("work-form-what"),
        trailing = if (state.templates.isEmpty()) null else ({ SavedPromptsMenu(state) }),
    ) {
        PromptEditor(
            value = shown,
            onValueChange = { next ->
                field = next
                if (next.text != d.prompt) state.setPrompt(next.text)
            },
            placeholder = placeholder,
            focusRequester = focus,
        )
        if (state.params.isNotEmpty()) {
            FormChipRow(
                chips = state.params.map { FormChip(it, "{{$it}}") },
                selection = null,
                mono = true,
                onSelect = { p ->
                    val next = inserting(shown, "{{$p}}")
                    field = next
                    state.setPrompt(next.text)
                    runCatching { focus.requestFocus() }
                },
                contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
            )
        }
    }
}

private fun whatFooter(state: WorkFormState): String? {
    if (state.kind == WorkKind.LOCAL_TERMINAL) return "Optional for an interactive session: it's sent as the first message once it opens."
    return when (state.draft.whenType) {
        WhenType.MANUAL -> null
        WhenType.SCHEDULE -> "A schedule carries no parameters."
        WhenType.WEBHOOK -> "Any top-level field of the POSTed JSON is available as {{field}}."
        else -> "Tap a parameter to insert it at the cursor."
    }
}

@Composable
private fun SavedPromptsMenu(state: WorkFormState) {
    var open by remember { mutableStateOf(false) }
    val colors = OptioTheme.colors
    androidx.compose.foundation.layout.Box {
        TextButton(onClick = { open = true }, contentPadding = PaddingValues(horizontal = Spacing.s), modifier = Modifier.testTag("work-form-saved-prompts")) {
            Icon(Icons.AutoMirrored.Outlined.MenuBook, contentDescription = null, tint = colors.accent, modifier = Modifier.size(16.dp))
            Text(" Saved prompts", style = OptioTheme.type.footnote.semibold(), color = colors.accent)
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            val scope = MenuScope { open = false }
            state.templates.forEach { t ->
                scope.MenuChoice(t.name, selected = false, subtitle = t.kind, onClick = { state.useTemplate(t) })
            }
        }
    }
}

// endregion

// region Then

@Composable
internal fun ThenSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    val footer = when (d.then) {
        Then.WAITS_FOR_MESSAGES ->
            "${d.agent.podLifecycle.hint} The system prompt and manual are optional — a blank manual means Optio's standard one (messaging other agents, reading the inbox, finishing a turn)."
        Then.WAITS_FOR_ME -> "Interactive sessions land in your “needs you” queue whenever they stop."
        Then.EXITS -> null
    }
    FormSectionCard(title = "Then", question = "When a turn ends", footer = footer, modifier = modifier.testTag("work-form-then")) {
        state.thenChoices.forEachIndexed { i, c ->
            if (i > 0) RowDivider(start = 56.dp)
            ChoiceRow(
                icon = thenIcon(c.value),
                title = thenTitle(c.value),
                subtitle = thenSubtitle(c.value, d.withRepo),
                selected = d.then == c.value,
                disabled = c.disabled.takeIf { d.then != c.value },
                onClick = { state.setThen(c.value) },
                modifier = Modifier.testTag("work-form-then-${c.value.raw}"),
            )
        }
        if (d.then == Then.WAITS_FOR_MESSAGES) {
            RowDivider()
            MenuRow(label = "Pod lifecycle", value = d.agent.podLifecycle.label) {
                PodLifecycle.entries.forEach { p ->
                    MenuChoice(p.label, selected = p == d.agent.podLifecycle, subtitle = p.hint, onClick = { state.setPodLifecycle(p) })
                }
            }
            RowDivider()
            TextAreaRow(
                value = d.agent.systemPrompt,
                onValueChange = state::setSystemPrompt,
                placeholder = "System prompt — who is this agent?",
                minLines = 2,
                fieldTag = "work-form-system-prompt",
            )
            RowDivider()
            TextAreaRow(
                value = d.agent.agentsMd,
                onValueChange = state::setAgentsMd,
                placeholder = "Operator manual (agents.md)",
                mono = true,
                minLines = 2,
                fieldTag = "work-form-agents-md",
            )
        }
    }
}

private fun thenSubtitle(then: Then, withRepo: Boolean): String = when (then) {
    Then.EXITS -> if (withRepo) "One turn of work; opens the PR, then finishes" else "One turn of work, then the run finishes"
    Then.WAITS_FOR_ME -> "Stops at its prompt after each turn until you type"
    Then.WAITS_FOR_MESSAGES -> "Named, keeps its memory, wakes when messaged"
}

// endregion

// region Name (+ more)

@Composable
internal fun NameSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    FormSectionCard(title = "Name", footer = nameFooter(state), modifier = modifier.testTag("work-form-name")) {
        TextAreaRow(
            value = d.name,
            onValueChange = state::setName,
            placeholder = state.namePlaceholder,
            fieldTag = "work-form-name-field",
            contentDescription = "Name",
        )
        if (d.then == Then.WAITS_FOR_MESSAGES) {
            RowDivider()
            ValueField(
                label = "Address",
                value = d.agent.slug,
                onValueChange = state::setSlug,
                placeholder = slugify(d.name.trim().ifEmpty { state.autoName }),
                fieldTag = "work-form-slug",
            )
        }
        if (state.namesRuns) {
            RowDivider()
            RunNameRows(state)
        }
    }
}

private fun nameFooter(state: WorkFormState): String {
    val d = state.draft
    val lines = mutableListOf<String>()
    when {
        d.name.isBlank() && state.isEditing -> lines += "Leave blank to keep the current name."
        d.name.isBlank() -> lines += "Blank calls it “${state.autoName}”."
        state.kind == WorkKind.REPO_TASK || (state.kind == WorkKind.REPO_BLUEPRINT && d.runName.isBlank()) ->
            lines += "Also the title of the task that opens the PR."
    }
    if (d.then == Then.WAITS_FOR_MESSAGES) lines += "The address is how other agents message it."
    if (state.namesRuns) {
        lines += when {
            state.params.isNotEmpty() -> "Each run's name is filled in from the trigger every time it fires; blank means the name above."
            d.whenType == WhenType.WEBHOOK -> "Use {{field}} in a run's name for any top-level field of the POSTed JSON; blank means the name above."
            else -> "Blank run names use the name above."
        }
    }
    return lines.joinToString(" ")
}

/** Recurring work names each run: a `{{param}}` template, filled in by every firing. */
@Composable
private fun RunNameRows(state: WorkFormState) {
    val d = state.draft
    var field by remember { mutableStateOf(TextFieldValue(d.runName, TextRange(d.runName.length))) }
    val shown = synced(field, d.runName)
    val params = state.params
    val placeholder = when {
        "ticketTitle" in params -> "Triage: {{ticketTitle}}"
        "title" in params -> "Review: {{title}}"
        else -> d.name.trim().ifEmpty { state.namePlaceholder }
    }
    val colors = OptioTheme.colors
    Column(Modifier.fillMaxWidth()) {
        Text(
            "Each run is named",
            style = OptioTheme.type.footnote,
            color = colors.secondaryLabel,
            modifier = Modifier.padding(start = Spacing.l, end = Spacing.l, top = Spacing.m),
        )
        val style = OptioTheme.type.monoBody.copy(color = colors.label)
        BasicTextField(
            value = shown,
            onValueChange = { next ->
                field = next
                if (next.text != d.runName) state.setRunName(next.text)
            },
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, imeAction = ImeAction.Done),
            modifier = Modifier
                .fillMaxWidth()
                .semantics { contentDescription = "Each run is named" }
                .testTag("work-form-run-name"),
            decorationBox = { inner ->
                androidx.compose.foundation.layout.Box(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s)) {
                    if (shown.text.isEmpty()) Text(placeholder, style = style.copy(color = colors.tertiaryLabel), maxLines = 1)
                    inner()
                }
            },
        )
        if (params.isNotEmpty()) {
            FormChipRow(
                chips = params.map { FormChip(it, "{{$it}}") },
                selection = null,
                mono = true,
                onSelect = { p ->
                    val next = inserting(shown, "{{$p}}")
                    field = next
                    state.setRunName(next.text)
                },
                contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
            )
        }
    }
}

@Composable
internal fun MoreOptionsSection(state: WorkFormState, modifier: Modifier = Modifier) {
    val d = state.draft
    val footer = if (state.more && d.then == Then.EXITS) {
        if (d.withRepo) "Lower priority runs sooner; 100 is the default." else "Failed runs retry with backoff, up to the limit."
    } else {
        null
    }
    FormSectionCard(title = null, footer = footer, modifier = modifier.testTag("work-form-more")) {
        KeyValueRow(
            label = "More options",
            value = null,
            onClick = { state.more = !state.more },
            trailing = {
                Icon(
                    if (state.more) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                    contentDescription = if (state.more) "Collapse" else "Expand",
                    tint = OptioTheme.colors.tertiaryLabel,
                )
            },
            modifier = Modifier.testTag("work-form-more-toggle"),
        )
        if (state.more) {
            RowDivider()
            TextAreaRow(
                value = d.description,
                onValueChange = state::setDescription,
                placeholder = "Description",
                minLines = 1,
                maxLines = 4,
                fieldTag = "work-form-description",
            )
            if (d.then == Then.EXITS) {
                if (d.withRepo) {
                    RowDivider()
                    StepperRow("Priority", d.priority, 1..1000, state::setPriority, step = 10)
                }
                RowDivider()
                StepperRow("Max retries", d.maxRetries, 0..10, state::setMaxRetries)
            }
            if (state.kind == WorkKind.REPO_TASK) {
                RowDivider()
                val n = d.dependsOn.size
                KeyValueRow(
                    label = "Wait for",
                    value = if (n == 0) "Nothing" else "$n task${if (n == 1) "" else "s"}",
                    onClick = { state.showDeps = true },
                    trailing = { Icon(Icons.Outlined.Link, contentDescription = null, tint = OptioTheme.colors.tertiaryLabel, modifier = Modifier.size(18.dp)) },
                    modifier = Modifier.testTag("work-form-deps"),
                )
            }
        }
    }
}

/** Pick the tasks a Task waits on (iOS `DependenciesPicker`): a checklist in a sheet. */
@Composable
internal fun DependenciesSheet(state: WorkFormState, onDismiss: () -> Unit) {
    val tasks = state.existingTasks.filter { it.state != "completed" && it.state != "cancelled" }.take(40)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)) {
        Text(
            "Wait for",
            style = OptioTheme.type.headline,
            color = OptioTheme.colors.label,
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
        )
        if (tasks.isEmpty()) {
            EmptyState(title = "Nothing to wait on", icon = Icons.Outlined.Link, message = "No other tasks are queued or running.")
        } else {
            LazyColumn(Modifier.fillMaxWidth().testTag("work-form-deps-list")) {
                items(tasks, key = { it.id }) { t ->
                    val on = t.id in state.draft.dependsOn
                    OptioRow(
                        title = t.title,
                        meta = metaText(t.state.replace('_', ' ')),
                        trailingContent = { Checkbox(checked = on, onCheckedChange = null) },
                        onClick = { state.toggleDependency(t.id) },
                    )
                }
                item {
                    Text(
                        "This task starts only after every checked task completes.",
                        style = OptioTheme.type.footnote,
                        color = OptioTheme.colors.secondaryLabel,
                        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m).navigationBarsPadding(),
                    )
                }
            }
        }
    }
}

// endregion
