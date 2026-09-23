package dev.optio.feature.library.prompts

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.size
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.LeaveIcon
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.LibraryForm
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.PromptKind
import dev.optio.feature.library.PromptTemplateInput
import dev.optio.feature.library.PromptTemplateRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.createPromptTemplate
import dev.optio.feature.library.updatePromptTemplate
import kotlinx.coroutines.Job

/**
 * Create ([id] null) or edit a named template (iOS `PromptEditorSheet`, a port of the web's
 * TemplateEditor). The form lives here as snapshot state so text fields update synchronously.
 */
class PromptEditorViewModel(private val api: ApiClient, val id: String?) : LibraryViewModel<Unit>() {
    var name by mutableStateOf("")
    var kind by mutableStateOf(PromptKind.PROMPT)
    var description by mutableStateOf("")

    /** An agent type, or "" for none. */
    var defaultAgentType by mutableStateOf("")
    var body by mutableStateOf("")

    var saving by mutableStateOf(false)
        private set

    private var populated = false

    val isNew: Boolean
        get() = id == null

    /** Loads the template being edited once (a re-appearance must not wipe the user's edits). */
    override suspend fun fetch() {
        if (id == null || populated) return
        populate(api.promptTemplate(id))
    }

    internal fun populate(template: PromptTemplateRow) {
        name = template.name
        kind = PromptKind.fromRaw(template.kind) ?: PromptKind.PROMPT
        description = template.description.orEmpty()
        defaultAgentType = template.defaultAgentType.orEmpty()
        body = template.template.orEmpty()
        populated = true
    }

    /** iOS: Save is disabled while saving or when the name is blank or the body empty. */
    val canSave: Boolean
        get() = !saving && name.isNotBlank() && body.isNotEmpty()

    fun input(): PromptTemplateInput = PromptTemplateInput(
        name = name.trim(),
        template = body,
        kind = kind.raw,
        description = description.ifEmpty { null },
        defaultAgentType = defaultAgentType.ifEmpty { null },
    )

    fun save(): Job? {
        if (!canSave) return null
        saving = true
        return action {
            try {
                if (id == null) {
                    val created = api.createPromptTemplate(input())
                    toast("Created “${created.name}”.")
                } else {
                    api.updatePromptTemplate(id, input())
                    toast("Saved.")
                }
                close()
            } finally {
                saving = false
            }
        }
    }
}

@Composable
internal fun PromptEditorScreen(
    id: String?,
    vm: PromptEditorViewModel = libraryViewModel { PromptEditorViewModel(it, id) },
) {
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::loadOnce)
    LibraryScaffold(
        title = if (vm.isNew) "New Template" else "Edit Template",
        leaveIcon = LeaveIcon.CLOSE,
        actions = {
            TextButton(onClick = vm::save, enabled = vm.canSave && state.value != null, modifier = Modifier.testTag("save")) {
                if (vm.saving) CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp) else Text("Save")
            }
        },
    ) { padding ->
        PromptEditorContent(
            state = state,
            name = vm.name,
            onNameChange = { vm.name = it },
            kind = vm.kind,
            onKindChange = { vm.kind = it },
            description = vm.description,
            onDescriptionChange = { vm.description = it },
            defaultAgentType = vm.defaultAgentType,
            onDefaultAgentTypeChange = { vm.defaultAgentType = it },
            body = vm.body,
            onBodyChange = { vm.body = it },
            onRetry = vm::refresh,
            contentPadding = padding,
        )
    }
}

/** The template form (stateless). */
@Composable
internal fun PromptEditorContent(
    state: LoadState<Unit>,
    name: String,
    onNameChange: (String) -> Unit,
    kind: PromptKind,
    onKindChange: (PromptKind) -> Unit,
    description: String,
    onDescriptionChange: (String) -> Unit,
    defaultAgentType: String,
    onDefaultAgentTypeChange: (String) -> Unit,
    body: String,
    onBodyChange: (String) -> Unit,
    onRetry: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryForm(state, what = "prompt", onRetry = onRetry, modifier = modifier, contentPadding = contentPadding, testTag = "prompt-editor") {
        GroupedCard {
            FormTextField(name, onNameChange, label = "Name", modifier = Modifier.testTag("prompt-name"))
            InsetDivider()
            PickerRow(
                label = "Kind",
                options = PromptKind.entries.map { it to it.label },
                selection = kind,
                onSelect = onKindChange,
                modifier = Modifier.testTag("prompt-kind"),
            )
            InsetDivider()
            FormTextField(
                description,
                onDescriptionChange,
                label = "Description",
                singleLine = false,
                modifier = Modifier.testTag("prompt-description"),
            )
            InsetDivider()
            PickerRow(
                label = "Default agent",
                options = listOf("" to "None") + AgentTypes.all,
                selection = defaultAgentType,
                onSelect = onDefaultAgentTypeChange,
                modifier = Modifier.testTag("prompt-agent"),
            )
        }
        GroupedCard(
            header = "Template body",
            footer = "Use {{param}} for substitution and {{#if flag}}\u2026{{/if}} for conditionals.",
        ) {
            FormTextField(
                body,
                onBodyChange,
                label = "Template",
                mono = true,
                singleLine = false,
                minLines = 10,
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("prompt-body"),
            )
        }
    }
}
