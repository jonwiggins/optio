package dev.optio.feature.tasks.scheduled

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ScheduledDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.tasks.common.FormPicker
import dev.optio.feature.tasks.common.FormScaffold
import dev.optio.feature.tasks.common.FormSection
import dev.optio.feature.tasks.common.FormStepper
import dev.optio.feature.tasks.common.FormSwitch
import dev.optio.feature.tasks.common.FormTextField
import dev.optio.feature.tasks.common.formPadding
import dev.optio.feature.tasks.data.RunFormatting
import dev.optio.feature.tasks.data.RunPromptTemplateRow
import dev.optio.feature.tasks.data.RunRepoRow

/** `ScheduledFormRoute(id?)`: create or edit a scheduled blueprint (iOS `TaskConfigFormSheet`). */
@Composable
fun ScheduledFormScreen(configId: String?) {
    val api = LocalApiClient.current
    val vm: ScheduledFormViewModel = viewModel { ScheduledFormViewModel(api, configId) }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    val loading by vm.loading.collectAsStateWithLifecycle()
    val draft by vm.draft.collectAsStateWithLifecycle()
    val repos by vm.repos.collectAsStateWithLifecycle()
    val templates by vm.templates.collectAsStateWithLifecycle()
    val saving by vm.saving.collectAsStateWithLifecycle()
    val error by vm.error.collectAsStateWithLifecycle()
    LaunchedEffect(vm) { vm.load() }
    ScheduledFormContent(
        loading = loading,
        draft = draft,
        repos = repos,
        templates = templates,
        saving = saving,
        error = error,
        onChange = vm::update,
        onSelectRepo = vm::selectRepo,
        onSelectTemplate = vm::selectTemplate,
        onRetryLoad = vm::load,
        onSave = {
            vm.save { saved ->
                toaster.success(if (draft.isEdit) "Saved" else "Created ${saved.name}")
                navigator.pop()
                if (!draft.isEdit) navigator.push(ScheduledDetailRoute(saved.id))
            }
        },
    )
}

@Composable
fun ScheduledFormContent(
    loading: LoadState<Unit>,
    draft: ScheduledDraft,
    repos: List<RunRepoRow>,
    templates: List<RunPromptTemplateRow>,
    saving: Boolean,
    error: Throwable?,
    onChange: ((ScheduledDraft) -> ScheduledDraft) -> Unit,
    onSelectRepo: (String) -> Unit,
    onSelectTemplate: (String) -> Unit,
    onSave: () -> Unit,
    modifier: Modifier = Modifier,
    onRetryLoad: () -> Unit = {},
) {
    FormScaffold(
        title = if (draft.isEdit) "Edit" else "New scheduled task",
        confirmLabel = "Save",
        canConfirm = draft.canSubmit && loading is LoadState.Loaded,
        saving = saving,
        onConfirm = onSave,
        modifier = modifier.testTag("scheduled-form"),
    ) { padding ->
        Loadable(state = loading, onRetry = onRetryLoad, onRefresh = null, what = "schedule", modifier = Modifier.padding(top = padding.calculateTopPadding())) {
            LazyColumn(Modifier.fillMaxSize().imePadding().readableWidth(), contentPadding = PaddingValues(bottom = padding.formPadding().calculateBottomPadding())) {
                item(key = "blueprint") {
                    FormSection(header = "Blueprint") {
                        FormTextField(draft.name, { v -> onChange { it.copy(name = v) } }, label = "Name", placeholder = "e.g. Daily CVE patch", testTag = "scheduled-name")
                        FormTextField(draft.description, { v -> onChange { it.copy(description = v) } }, label = "Description", singleLine = false, maxLines = 3, testTag = "scheduled-description")
                        FormSwitch("Enabled", draft.enabled, { v -> onChange { it.copy(enabled = v) } }, testTag = "scheduled-enabled")
                    }
                }
                item(key = "where") {
                    FormSection(header = "Where") {
                        val options = repos.map { it.repoUrl to it.displayName }.let { list ->
                            if (draft.repoUrl.isEmpty() || list.any { it.first == draft.repoUrl }) list else list + (draft.repoUrl to RunFormatting.repoShortName(draft.repoUrl))
                        }
                        FormPicker(label = "Repository", selection = draft.repoUrl, options = options, onSelect = onSelectRepo, testTag = "scheduled-repo")
                        FormTextField(draft.branch, { v -> onChange { it.copy(branch = v) } }, label = "Branch", mono = true, capitalization = KeyboardCapitalization.None, testTag = "scheduled-branch")
                    }
                }
                item(key = "who") {
                    FormSection(header = "Who") {
                        FormPicker(
                            label = "Agent",
                            selection = draft.agentType,
                            options = listOf("" to "Repo default") + RunFormatting.agentTypes,
                            onSelect = { v -> onChange { it.copy(agentType = v) } },
                            testTag = "scheduled-agent",
                        )
                    }
                }
                item(key = "what") {
                    FormSection(header = "What", footer = "{{param}} placeholders are filled from the trigger payload when the task is spawned.") {
                        FormTextField(draft.title, { v -> onChange { it.copy(title = v) } }, label = "Task title template", testTag = "scheduled-title")
                        if (templates.isNotEmpty()) {
                            FormPicker(
                                label = "Prompt template",
                                selection = draft.templateId,
                                options = listOf("" to "None") + templates.map { it.id to it.name },
                                onSelect = onSelectTemplate,
                                testTag = "scheduled-template",
                            )
                        }
                        FormTextField(
                            draft.prompt,
                            { v -> onChange { it.copy(prompt = v) } },
                            label = "Prompt",
                            singleLine = false,
                            minLines = 6,
                            maxLines = 20,
                            mono = true,
                            testTag = "scheduled-prompt",
                        )
                    }
                }
                item(key = "limits") {
                    FormSection(header = "Limits") {
                        FormStepper("Priority", draft.priority, 0..1000, { v -> onChange { it.copy(priority = v) } }, step = 10, testTag = "scheduled-priority")
                        FormStepper("Max retries", draft.maxRetries, 0..10, { v -> onChange { it.copy(maxRetries = v) } }, testTag = "scheduled-max-retries")
                    }
                }
                if (error != null) {
                    item(key = "error") { ErrorRow(error, modifier = Modifier.padding(top = Spacing.m).testTag("scheduled-form-error")) }
                }
            }
        }
    }
}
