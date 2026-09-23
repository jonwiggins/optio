package dev.optio.feature.library.prompts

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.padding
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Visibility
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.PromptEditRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.ApiError
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.NoteRow
import dev.optio.feature.library.PromptKind
import dev.optio.feature.library.PromptTemplateRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.deletePromptTemplate
import dev.optio.feature.library.groupedCard
import dev.optio.feature.library.listPromptTemplates
import dev.optio.feature.library.loadStateItems
import dev.optio.feature.library.parseKeyValueLines
import dev.optio.feature.library.previewPromptTemplate
import kotlinx.coroutines.Job

/** The template [id] from the list (the API has no single-template GET, iOS re-reads the list too). */
internal suspend fun ApiClient.promptTemplate(id: String): PromptTemplateRow =
    listPromptTemplates().firstOrNull { it.id == id } ?: throw ApiError(ApiError.NOT_FOUND, "Template not found")

/** One named template (iOS `PromptDetailView`): what it is, its body, a live preview, delete. */
class PromptDetailViewModel(private val api: ApiClient, val id: String) : LibraryViewModel<PromptTemplateRow>() {
    /** Values typed for the template's `{{param}}` names. */
    val params = mutableStateMapOf<String, String>()

    /** `key=value` lines for params the body doesn't declare. */
    var extraParams by mutableStateOf("")

    var rendered by mutableStateOf<String?>(null)
        private set

    var rendering by mutableStateOf(false)
        private set

    var deleting by mutableStateOf(false)
        private set

    override suspend fun fetch(): PromptTemplateRow = api.promptTemplate(id)

    /** What [preview] sends: the non-empty typed values, then the extra lines (which win). */
    fun previewParams(): Map<String, String> = params.filterValues { it.isNotEmpty() } + parseKeyValueLines(extraParams)

    fun preview(): Job? {
        if (rendering) return null
        rendering = true
        return action {
            try {
                rendered = api.previewPromptTemplate(id, previewParams())
            } finally {
                rendering = false
            }
        }
    }

    fun delete(): Job? {
        if (deleting) return null
        deleting = true
        return action {
            try {
                api.deletePromptTemplate(id)
                toast("Deleted “${state.value.value?.name ?: "template"}”.")
                close()
            } finally {
                deleting = false
            }
        }
    }
}

@Composable
internal fun PromptDetailScreen(
    id: String,
    vm: PromptDetailViewModel = libraryViewModel { PromptDetailViewModel(it, id) },
) {
    val navigator = LocalNavigator.current
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    LibraryScaffold(
        title = state.value?.name ?: "Prompt",
        actions = {
            if (canMutate && state.value != null) {
                TextButton(onClick = { navigator.push(PromptEditRoute(id)) }, modifier = Modifier.testTag("edit-prompt")) { Text("Edit") }
            }
        },
    ) { padding ->
        PromptDetailContent(
            state = state,
            params = vm.params,
            onParamChange = { name, value -> vm.params[name] = value },
            extraParams = vm.extraParams,
            onExtraParamsChange = { vm.extraParams = it },
            rendered = vm.rendered,
            rendering = vm.rendering,
            deleting = vm.deleting,
            canMutate = canMutate,
            onRefresh = vm::refresh,
            onPreview = vm::preview,
            onDelete = {
                val name = state.value?.name ?: "template"
                confirm.ask("Delete “$name”?", confirmLabel = "Delete", destructive = true, onConfirm = vm::delete)
            },
            contentPadding = padding,
        )
    }
    ConfirmHost(confirm)
}

/** The prompt detail body (stateless). */
@Composable
internal fun PromptDetailContent(
    state: LoadState<PromptTemplateRow>,
    params: Map<String, String>,
    onParamChange: (String, String) -> Unit,
    extraParams: String,
    onExtraParamsChange: (String) -> Unit,
    rendered: String?,
    rendering: Boolean,
    deleting: Boolean,
    canMutate: Boolean,
    onRefresh: () -> Unit,
    onPreview: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    val now = rememberNow()
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "prompt-detail") {
        loadStateItems(state, what = "prompt", onRetry = onRefresh) { template ->
            groupedCard(key = "info") {
                KeyValueRow("Kind", PromptKind.label(template.kind))
                template.defaultAgentType?.takeIf { it.isNotEmpty() }?.let {
                    InsetDivider()
                    KeyValueRow("Default agent", AgentTypes.label(it))
                }
                template.description?.takeIf { it.isNotEmpty() }?.let {
                    InsetDivider()
                    NoteRow(it)
                }
                template.updatedAt?.isoInstant()?.let {
                    InsetDivider()
                    KeyValueRow("Updated", it.relativeDescription(now))
                }
            }
            groupedCard(key = "body", header = "Template body") {
                CodeBlock(template.template.orEmpty().ifEmpty { " " }, modifier = Modifier.padding(Spacing.m).testTag("template-body"))
            }
            groupedCard(key = "preview", header = "Preview with params") {
                val names = template.paramNames
                if (names.isEmpty()) {
                    NoteRow("No {{param}} placeholders detected. Add extra params below as key=value lines.")
                } else {
                    names.forEachIndexed { index, name ->
                        if (index > 0) InsetDivider()
                        FormTextField(
                            value = params[name].orEmpty(),
                            onValueChange = { onParamChange(name, it) },
                            label = name,
                            labelMono = true,
                            placeholder = "value",
                            keyboardOptions = CodeKeyboard,
                            modifier = Modifier.testTag("param-$name"),
                        )
                    }
                }
                InsetDivider()
                FormTextField(
                    value = extraParams,
                    onValueChange = onExtraParamsChange,
                    label = "Extra params",
                    placeholder = "extra=value (one per line)",
                    mono = true,
                    singleLine = false,
                    keyboardOptions = CodeKeyboard,
                    modifier = Modifier.testTag("extra-params"),
                )
                if (canMutate) {
                    InsetDivider()
                    ActionRow(
                        "Render preview",
                        onClick = onPreview,
                        icon = Icons.Outlined.Visibility,
                        busy = rendering,
                        modifier = Modifier.testTag("render-preview"),
                    )
                }
            }
            if (rendered != null) {
                groupedCard(key = "rendered", header = "Rendered") {
                    CodeBlock(rendered.ifEmpty { " " }, modifier = Modifier.padding(Spacing.m).testTag("rendered"))
                }
            }
            if (canMutate) {
                groupedCard(key = "delete") {
                    ActionRow(
                        "Delete template",
                        onClick = onDelete,
                        icon = Icons.Outlined.Delete,
                        destructive = true,
                        busy = deleting,
                        modifier = Modifier.testTag("delete-prompt"),
                    )
                }
            }
            item(key = "bottom") { androidx.compose.foundation.layout.Spacer(Modifier.padding(bottom = 24.dp)) }
        }
    }
}
