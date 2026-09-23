package dev.optio.feature.library.prompts

import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.ShortText
import androidx.compose.material.icons.filled.Add
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.PromptDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.hub.HubActions
import dev.optio.core.ui.state.LoadState
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.PromptKind
import dev.optio.feature.library.PromptTemplateRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SwipeToDelete
import dev.optio.feature.library.deletePromptTemplate
import dev.optio.feature.library.groupedItems
import dev.optio.feature.library.listPromptTemplates
import dev.optio.feature.library.loadStateItems
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** The kind filter's "everything" value. */
internal const val ALL_KINDS = "all"

/** Library › Prompts (iOS `PromptsListModel`): every named template, filtered by kind on the device. */
class PromptsViewModel(private val api: ApiClient) : LibraryViewModel<List<PromptTemplateRow>>() {
    private val _filter = MutableStateFlow(ALL_KINDS)

    /** `all` or a [PromptKind.raw]. */
    val filter: StateFlow<String> = _filter.asStateFlow()

    override suspend fun fetch(): List<PromptTemplateRow> = api.listPromptTemplates()

    fun setFilter(value: String) {
        _filter.value = value
    }

    fun delete(template: PromptTemplateRow) = action {
        api.deletePromptTemplate(template.id)
        toast("Deleted “${template.name}”.")
        reloadQuietly()
    }
}

/** The templates [filter] keeps (iOS `visible`). */
internal fun visiblePrompts(templates: List<PromptTemplateRow>, filter: String): List<PromptTemplateRow> =
    if (filter == ALL_KINDS) templates else templates.filter { it.kind == filter }

internal val PromptFilterOptions: List<Pair<String, String>> =
    listOf(ALL_KINDS to "All") + PromptKind.entries.map { it.raw to it.shortLabel }

/** Library › Prompts: the section body plus a "New prompt" action for members. */
@Composable
internal fun PromptsScreen(
    contentPadding: PaddingValues,
    modifier: Modifier = Modifier,
    vm: PromptsViewModel = libraryViewModel { PromptsViewModel(it) },
) {
    val navigator = LocalNavigator.current
    val canMutate = Roles.canMutate
    val confirm = rememberConfirmState()
    val state by vm.state.collectAsStateWithLifecycle()
    val filter by vm.filter.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    HubActions {
        if (canMutate) {
            IconButton(onClick = { navigator.push(PromptDetailRoute(null)) }, modifier = Modifier.testTag("add-prompt")) {
                Icon(Icons.Filled.Add, contentDescription = "New prompt")
            }
        }
    }
    PromptsContent(
        state = state,
        filter = filter,
        onFilter = vm::setFilter,
        onRefresh = vm::refresh,
        onOpen = { navigator.push(PromptDetailRoute(it.id)) },
        onDelete = if (canMutate) {
            { template ->
                confirm.ask("Delete “${template.name}”?", confirmLabel = "Delete", destructive = true) { vm.delete(template) }
            }
        } else {
            null
        },
        contentPadding = contentPadding,
        modifier = modifier,
    )
    ConfirmHost(confirm)
}

/** The prompts list (stateless): kind chips, then skeleton / error / empty / the template rows. */
@Composable
internal fun PromptsContent(
    state: LoadState<List<PromptTemplateRow>>,
    filter: String,
    onFilter: (String) -> Unit,
    onRefresh: () -> Unit,
    onOpen: (PromptTemplateRow) -> Unit,
    onDelete: ((PromptTemplateRow) -> Unit)?,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "prompts-list") {
        item(key = "filter", contentType = "chips") {
            ChipPicker(options = PromptFilterOptions, selection = filter, onSelect = onFilter)
        }
        loadStateItems(state, what = "prompts", onRetry = onRefresh) { templates ->
            val visible = visiblePrompts(templates, filter)
            if (visible.isEmpty()) {
                item(key = "empty", contentType = "state") {
                    EmptyState(
                        title = "No templates",
                        icon = Icons.AutoMirrored.Outlined.ShortText,
                        message = if (filter == ALL_KINDS) "Create a reusable prompt template." else "No templates of this kind yet.",
                    )
                }
            } else {
                groupedItems(visible, key = { it.id }) { template, position ->
                    GroupedRow(position) {
                        SwipeToDelete(enabled = onDelete != null, onDelete = { onDelete?.invoke(template) }) {
                            PromptRow(template, onClick = { onOpen(template) })
                        }
                    }
                }
            }
        }
    }
}

/** One template (iOS `row(_:)`): name; kind · default agent · description; the body on one line. */
@Composable
internal fun PromptRow(template: PromptTemplateRow, onClick: () -> Unit, modifier: Modifier = Modifier) {
    OptioRow(
        title = template.name,
        meta = metaText(
            PromptKind.shortLabel(template.kind),
            if (template.isDefault == true) "default" else null,
            template.defaultAgentType?.takeIf { it.isNotEmpty() }?.let(AgentTypes::label),
            template.description?.takeIf { it.isNotEmpty() },
        ),
        footer = template.template?.let { mono(it.replace('\n', ' ')) },
        titleMaxLines = 1,
        onClick = onClick,
        modifier = modifier.testTag("prompt-${template.id}"),
    )
}
