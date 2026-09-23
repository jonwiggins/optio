package dev.optio.feature.agents

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Remove
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.PersistentAgent
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.AgentDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.launch

/**
 * Create ([agentId] null) or edit a persistent agent (iOS `AgentFormSheet`, a full-screen route
 * here). Creating lands on the new agent's Chat through the shell's "created work" path; saving an
 * edit returns to the agent, which refreshes on return.
 */
@Composable
fun AgentFormScreen(
    agentId: String?,
    modifier: Modifier = Modifier,
) {
    val api = LocalApiClient.current
    val vm: AgentFormViewModel = viewModel(key = "agent-form:${agentId ?: "new"}") { AgentFormViewModel(agentId, api) }
    val agent by vm.agent.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    AgentFormContent(
        editing = vm.isEditing,
        agent = agent,
        draft = draft,
        saving = saving,
        error = error,
        onChange = vm::edit,
        onRetry = vm::load,
        onCancel = navigator::pop,
        onSave = {
            scope.launch {
                val saved = vm.save() ?: return@launch
                if (vm.isEditing) {
                    toaster.success("Saved")
                    navigator.pop()
                } else {
                    navigator.pop()
                    navigator.showCreatedWork(AgentDetailRoute(saved.id), "${saved.name} created")
                }
            }
        },
        modifier = modifier,
    )
}

/** The stateless form. */
@Composable
fun AgentFormContent(
    editing: Boolean,
    agent: LoadState<PersistentAgent?>,
    draft: AgentFormDraft,
    saving: Boolean,
    error: Throwable?,
    onChange: ((AgentFormDraft) -> AgentFormDraft) -> Unit,
    onRetry: () -> Unit,
    onCancel: () -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val valid = draft.isValid(editing)
    val ready = !editing || agent.value != null
    Scaffold(
        modifier = modifier.testTag("agent-form"),
        topBar = {
            TopAppBar(
                title = { Text(if (editing) "Edit agent" else "New agent") },
                navigationIcon = {
                    IconButton(onClick = onCancel, modifier = Modifier.testTag("back")) {
                        Icon(Icons.Filled.Close, contentDescription = "Cancel")
                    }
                },
                actions = {
                    TextButton(
                        onClick = onSave,
                        enabled = ready && valid && !saving,
                        modifier = Modifier.testTag("agent-form-save"),
                    ) { Text(if (saving) "Saving…" else if (editing) "Save" else "Create") }
                },
            )
        },
    ) { padding ->
        val body = Modifier.fillMaxSize().padding(padding)
        when {
            !ready && agent is LoadState.Failed ->
                Column(body) { ErrorRow(error = agent.error, what = "agent", retry = onRetry) }
            !ready -> Column(body) { SkeletonRows(count = 6) }
            else -> AgentFormFields(editing, draft, error, onChange, body)
        }
    }
}

@Composable
private fun AgentFormFields(
    editing: Boolean,
    draft: AgentFormDraft,
    error: Throwable?,
    onChange: ((AgentFormDraft) -> AgentFormDraft) -> Unit,
    modifier: Modifier,
) {
    val colors = OptioTheme.colors
    Column(
        modifier
            .imePaddingInWindow()
            .verticalScroll(rememberScrollState())
            .readableWidth()
            .padding(bottom = Spacing.xl),
    ) {
        if (error != null) ErrorRow(error = error, what = null)

        FormHeader("Identity")
        FieldColumn {
            if (!editing) {
                OutlinedTextField(
                    value = draft.slug,
                    onValueChange = { v -> onChange { it.copy(slug = v.lowercase().trim()) } },
                    label = { Text("Slug (a-z, 0-9, hyphens)") },
                    singleLine = true,
                    textStyle = OptioTheme.type.body.mono(),
                    isError = draft.slug.isNotEmpty() && !AgentFormDraft.SLUG.matches(draft.slug),
                    keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().testTag("agent-slug"),
                )
            }
            OutlinedTextField(
                value = draft.name,
                onValueChange = { v -> onChange { it.copy(name = v) } },
                label = { Text("Name") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words),
                modifier = Modifier.fillMaxWidth().testTag("agent-name"),
            )
            OutlinedTextField(
                value = draft.description,
                onValueChange = { v -> onChange { it.copy(description = v) } },
                label = { Text("Description") },
                maxLines = 3,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                modifier = Modifier.fillMaxWidth().testTag("agent-description"),
            )
        }

        FormHeader("Runtime")
        FieldColumn {
            MenuField("Runtime", draft.agentRuntime, AgentDefaults.RUNTIMES, tag = "agent-runtime") { v -> onChange { it.copy(agentRuntime = v) } }
            OutlinedTextField(
                value = draft.model,
                onValueChange = { v -> onChange { it.copy(model = v) } },
                label = { Text("Model (default for runtime)") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.None, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("agent-model"),
            )
            MenuField(
                "Pod lifecycle",
                draft.podLifecycle,
                AgentDefaults.LIFECYCLES,
                tag = "agent-lifecycle",
                supporting = AgentDefaults.lifecycleHint(draft.podLifecycle),
            ) { v -> onChange { it.copy(podLifecycle = v) } }
        }
        if (editing) {
            GroupedSection(contentPadding = androidx.compose.foundation.layout.PaddingValues(horizontal = Spacing.l, vertical = Spacing.s)) {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    Text("Enabled", style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
                    Switch(
                        checked = draft.enabled,
                        onCheckedChange = { v -> onChange { it.copy(enabled = v) } },
                        modifier = Modifier.testTag("agent-enabled"),
                    )
                }
            }
        }

        FormHeader("Limits")
        GroupedSection(footer = "Idle pod TTL applies to sticky mode only. Consecutive failures past the limit move the agent to FAILED.") {
            StepperRow(
                label = "Idle pod TTL",
                value = "${draft.idlePodTimeoutMs / 1000}s",
                enabled = draft.podLifecycle == "sticky",
                canDecrement = draft.idlePodTimeoutMs > AgentFormDraft.IDLE_TTL_RANGE.first,
                canIncrement = draft.idlePodTimeoutMs < AgentFormDraft.IDLE_TTL_RANGE.last,
                onStep = { d ->
                    onChange { it.copy(idlePodTimeoutMs = (it.idlePodTimeoutMs + d * AgentFormDraft.IDLE_TTL_STEP).coerceIn(AgentFormDraft.IDLE_TTL_RANGE)) }
                },
                tag = "idle-ttl",
            )
            InsetDivider()
            StepperRow(
                label = "Max turn duration",
                value = "${draft.maxTurnDurationMs / 60_000} min",
                canDecrement = draft.maxTurnDurationMs > AgentFormDraft.TURN_DURATION_RANGE.first,
                canIncrement = draft.maxTurnDurationMs < AgentFormDraft.TURN_DURATION_RANGE.last,
                onStep = { d ->
                    onChange {
                        it.copy(maxTurnDurationMs = (it.maxTurnDurationMs + d * AgentFormDraft.TURN_DURATION_STEP).coerceIn(AgentFormDraft.TURN_DURATION_RANGE))
                    }
                },
                tag = "turn-duration",
            )
            InsetDivider()
            StepperRow(
                label = "Max turns",
                value = "${draft.maxTurns}",
                canDecrement = draft.maxTurns > AgentFormDraft.MAX_TURNS_RANGE.first,
                canIncrement = draft.maxTurns < AgentFormDraft.MAX_TURNS_RANGE.last,
                onStep = { d -> onChange { it.copy(maxTurns = (it.maxTurns + d).coerceIn(AgentFormDraft.MAX_TURNS_RANGE)) } },
                tag = "max-turns",
            )
            InsetDivider()
            StepperRow(
                label = "Failures before halt",
                value = "${draft.consecutiveFailureLimit}",
                canDecrement = draft.consecutiveFailureLimit > AgentFormDraft.FAILURE_LIMIT_RANGE.first,
                canIncrement = draft.consecutiveFailureLimit < AgentFormDraft.FAILURE_LIMIT_RANGE.last,
                onStep = { d ->
                    onChange { it.copy(consecutiveFailureLimit = (it.consecutiveFailureLimit + d).coerceIn(AgentFormDraft.FAILURE_LIMIT_RANGE)) }
                },
                tag = "failure-limit",
            )
        }

        PromptField(
            title = "System prompt",
            footer = "Persona — who is this agent? Stays constant across all turns.",
            value = draft.systemPrompt,
            minLines = 4,
            maxLines = 10,
            tag = "agent-system-prompt",
        ) { v -> onChange { it.copy(systemPrompt = v) } }
        PromptField(
            title = "Operator manual (agents.md)",
            footer = "How to use the Optio internal API. Shown to the agent every turn.",
            value = draft.agentsMd,
            minLines = 6,
            maxLines = 14,
            tag = "agent-agents-md",
        ) { v -> onChange { it.copy(agentsMd = v) } }
        PromptField(
            title = "Initial prompt",
            footer = "The agent's first mission — sent only on the first turn.",
            value = draft.initialPrompt,
            minLines = 4,
            maxLines = 10,
            tag = "agent-initial-prompt",
        ) { v -> onChange { it.copy(initialPrompt = v) } }

        draft.problem(editing)?.let { problem ->
            Text(
                problem,
                style = OptioTheme.type.footnote,
                color = colors.secondaryLabel,
                modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m).testTag("agent-form-problem"),
            )
        }
    }
}

@Composable
private fun FormHeader(title: String) {
    SectionHeader(title)
}

@Composable
private fun FieldColumn(content: @Composable ColumnScope.() -> Unit) {
    Column(
        Modifier.fillMaxWidth().padding(horizontal = Spacing.l),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
        content = content,
    )
}

/** A read-only field that opens a menu of [options]. */
@Composable
private fun MenuField(
    label: String,
    value: String,
    options: List<String>,
    tag: String,
    supporting: String? = null,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    Box(Modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = value,
            onValueChange = {},
            readOnly = true,
            label = { Text(label) },
            singleLine = true,
            trailingIcon = { Icon(Icons.Filled.ArrowDropDown, contentDescription = null) },
            supportingText = supporting?.let { { Text(it) } },
            modifier = Modifier.fillMaxWidth(),
        )
        Box(
            Modifier
                .matchParentSize()
                .clickable(role = Role.DropdownList, onClickLabel = label) { open = true }
                .testTag(tag),
        )
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            options.forEach { option ->
                DropdownMenuItem(
                    text = { Text(option) },
                    onClick = {
                        open = false
                        onSelect(option)
                    },
                )
            }
        }
    }
}

/** iOS `Stepper`: the value, then − and +. */
@Composable
private fun StepperRow(
    label: String,
    value: String,
    canDecrement: Boolean,
    canIncrement: Boolean,
    onStep: (Int) -> Unit,
    tag: String,
    enabled: Boolean = true,
) {
    val colors = OptioTheme.colors
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.xs, top = 2.dp, bottom = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = OptioTheme.type.body, color = if (enabled) colors.label else colors.tertiaryLabel, modifier = Modifier.weight(1f))
        Text(value, style = OptioTheme.type.body, color = if (enabled) colors.secondaryLabel else colors.tertiaryLabel, modifier = Modifier.testTag("$tag-value"))
        IconButton(onClick = { onStep(-1) }, enabled = enabled && canDecrement, modifier = Modifier.testTag("$tag-minus")) {
            Icon(Icons.Outlined.Remove, contentDescription = "Decrease $label")
        }
        IconButton(onClick = { onStep(1) }, enabled = enabled && canIncrement, modifier = Modifier.testTag("$tag-plus")) {
            Icon(Icons.Outlined.Add, contentDescription = "Increase $label")
        }
    }
}

@Composable
private fun PromptField(
    title: String,
    footer: String,
    value: String,
    minLines: Int,
    maxLines: Int,
    tag: String,
    onValueChange: (String) -> Unit,
) {
    FormHeader(title)
    FieldColumn {
        OutlinedTextField(
            value = value,
            onValueChange = onValueChange,
            minLines = minLines,
            maxLines = maxLines,
            textStyle = OptioTheme.type.footnote.mono(),
            supportingText = { Text(footer) },
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
            modifier = Modifier.fillMaxWidth().testTag(tag),
        )
    }
}
