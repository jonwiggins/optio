package dev.optio.feature.tasks.job

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.JobDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.tasks.common.FormCaption
import dev.optio.feature.tasks.common.FormPicker
import dev.optio.feature.tasks.common.FormScaffold
import dev.optio.feature.tasks.common.FormSection
import dev.optio.feature.tasks.common.FormStepper
import dev.optio.feature.tasks.common.FormSwitch
import dev.optio.feature.tasks.common.FormTextField
import dev.optio.feature.tasks.common.formPadding
import dev.optio.feature.tasks.data.JobFormat
import dev.optio.feature.tasks.trigger.TriggerEditor

/** `JobFormRoute(id?)`: create or edit a Job (iOS `JobFormView`). */
@Composable
fun JobFormScreen(jobId: String?) {
    val api = LocalApiClient.current
    val vm: JobFormViewModel = viewModel { JobFormViewModel(api, jobId) }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val loading by vm.loading.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    LaunchedEffect(vm) { vm.load() }
    JobFormContent(
        loading = loading,
        draft = draft,
        saving = saving,
        error = error,
        baseUrl = api.baseUrl?.toString(),
        onChange = vm::update,
        onRetryLoad = vm::load,
        onSave = {
            vm.save { saved ->
                if (saved.created) {
                    toaster.success("Created ${saved.job.name}")
                    navigator.pop()
                    navigator.push(JobDetailRoute(saved.job.id))
                } else {
                    toaster.success("Saved")
                    navigator.pop()
                }
            }
        },
    )
}

/** A detected `{{PARAM}}`, by its exact name (iOS: an accent badge). */
@Composable
private fun ParamChip(name: String) {
    Text(
        name,
        style = OptioTheme.type.monoCaption,
        color = Tone.ACCENT.textColor,
        modifier = Modifier
            .background(Tone.ACCENT.color.copy(alpha = 0.14f), Radius.capsuleShape)
            .padding(horizontal = 8.dp, vertical = 3.dp)
            .testTag("param-chip-$name"),
    )
}

/** The form itself (stateless). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun JobFormContent(
    loading: LoadState<Unit>,
    draft: JobDraft,
    saving: Boolean,
    error: Throwable?,
    baseUrl: String?,
    onChange: ((JobDraft) -> JobDraft) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    onRetryLoad: () -> Unit = {},
) {
    FormScaffold(
        title = if (draft.isEdit) "Edit Job" else "New Job",
        confirmLabel = if (draft.isEdit) "Save" else "Create",
        canConfirm = draft.canSave && loading is LoadState.Loaded,
        saving = saving,
        onConfirm = onSave,
        modifier = modifier.testTag("job-form"),
    ) { padding ->
        Loadable(state = loading, onRetry = onRetryLoad, onRefresh = null, what = "job", modifier = Modifier.padding(top = padding.calculateTopPadding())) {
            LazyColumn(Modifier.fillMaxSize().imePadding(), contentPadding = PaddingValues(bottom = padding.formPadding().calculateBottomPadding())) {
                item(key = "basics") {
                    FormSection(header = "Basics") {
                        FormTextField(draft.name, { v -> onChange { it.copy(name = v) } }, label = "Name", capitalization = KeyboardCapitalization.Words, testTag = "job-name")
                        FormTextField(
                            draft.description,
                            { v -> onChange { it.copy(description = v) } },
                            label = "Description (optional)",
                            singleLine = false,
                            maxLines = 3,
                            testTag = "job-description",
                        )
                        FormSwitch("Enabled", draft.enabled, { v -> onChange { it.copy(enabled = v) } }, testTag = "job-enabled")
                    }
                }
                item(key = "agent") {
                    FormSection(header = "Agent") {
                        FormPicker(
                            label = "Runtime",
                            selection = draft.agentRuntime,
                            options = JobFormat.agentRuntimes.let { list ->
                                if (list.any { it.first == draft.agentRuntime }) list else list + (draft.agentRuntime to JobFormat.runtimeLabel(draft.agentRuntime))
                            },
                            onSelect = { v -> onChange { it.copy(agentRuntime = v) } },
                            testTag = "job-runtime",
                        )
                        FormTextField(
                            draft.modelName,
                            { v -> onChange { it.copy(modelName = v) } },
                            label = "Model",
                            placeholder = "e.g. sonnet, opus",
                            capitalization = KeyboardCapitalization.None,
                            testTag = "job-model",
                        )
                        FormTextField(
                            draft.maxTurns,
                            { v -> onChange { it.copy(maxTurns = v.filter(Char::isDigit)) } },
                            label = "Max turns",
                            placeholder = "default",
                            keyboardType = KeyboardType.Number,
                            isError = !draft.maxTurnsValid,
                            supportingText = if (!draft.maxTurnsValid) "A whole number above zero." else null,
                            testTag = "job-max-turns",
                        )
                        FormTextField(
                            draft.budgetUsd,
                            { v -> onChange { it.copy(budgetUsd = v.filter { c -> c.isDigit() || c == '.' }) } },
                            label = "Budget USD",
                            placeholder = "e.g. 5.00",
                            keyboardType = KeyboardType.Decimal,
                            isError = !draft.budgetValid,
                            supportingText = if (!draft.budgetValid) "A dollar amount above zero." else null,
                            testTag = "job-budget",
                        )
                    }
                }
                item(key = "prompt") {
                    FormSection(header = "Prompt Template") {
                        FormTextField(
                            draft.promptTemplate,
                            { v -> onChange { it.copy(promptTemplate = v) } },
                            label = "Prompt template",
                            singleLine = false,
                            minLines = 6,
                            maxLines = 20,
                            mono = true,
                            testTag = "job-prompt",
                        )
                        val params = draft.detectedParams
                        if (draft.promptTemplate.isEmpty()) {
                            FormCaption("Use {{PARAM}} placeholders; they become run parameters.")
                        } else if (params.isNotEmpty()) {
                            FormCaption("Detected parameters")
                            FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.s), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                                params.forEach { ParamChip(it) }
                            }
                        }
                    }
                }
                item(key = "triggers") {
                    FormSection(
                        header = "Triggers",
                        footer = "Manual triggers run on demand. Schedules use cron. Webhooks are reachable at /api/hooks/<path>.",
                    ) {
                        draft.visibleTriggers.forEachIndexed { index, trigger ->
                            if (index > 0) HorizontalDivider(color = OptioTheme.colors.separator)
                            Column(Modifier.testTag("job-trigger-$index"), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                                Row(verticalAlignment = Alignment.CenterVertically) {
                                    Text("Trigger ${index + 1}", style = OptioTheme.type.subheadline.semibold(), color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
                                    IconButton(onClick = { onChange { it.removeTrigger(trigger.key) } }, modifier = Modifier.testTag("job-trigger-remove-$index")) {
                                        Icon(Icons.Outlined.Delete, contentDescription = "Remove trigger", tint = OptioTheme.colors.secondaryLabel)
                                    }
                                }
                                TriggerEditor(
                                    draft = trigger,
                                    onChange = { next -> onChange { it.withTrigger(trigger.key) { next } } },
                                    baseUrl = baseUrl,
                                )
                            }
                        }
                        OutlinedButton(onClick = { onChange { it.addTrigger() } }, modifier = Modifier.testTag("job-add-trigger")) {
                            Icon(Icons.Outlined.Add, contentDescription = null)
                            Text("Add trigger", modifier = Modifier.padding(start = Spacing.s))
                        }
                    }
                }
                item(key = "advanced") {
                    FormSection(header = "Advanced") {
                        FormStepper("Max concurrent", draft.maxConcurrent, 1..50, { v -> onChange { it.copy(maxConcurrent = v) } }, testTag = "job-max-concurrent")
                        FormStepper("Max retries", draft.maxRetries, 0..10, { v -> onChange { it.copy(maxRetries = v) } }, testTag = "job-max-retries")
                        FormStepper("Warm pool", draft.warmPoolSize, 0..20, { v -> onChange { it.copy(warmPoolSize = v) } }, testTag = "job-warm-pool")
                        FormStepper("Pod instances", draft.maxPodInstances, 1..20, { v -> onChange { it.copy(maxPodInstances = v) } }, testTag = "job-pod-instances")
                        FormStepper("Agents per pod", draft.maxAgentsPerPod, 1..50, { v -> onChange { it.copy(maxAgentsPerPod = v) } }, testTag = "job-agents-per-pod")
                    }
                }
                if (error != null) {
                    item(key = "error") { ErrorRow(error, modifier = Modifier.padding(top = Spacing.m).testTag("job-form-error")) }
                }
            }
        }
    }
}
