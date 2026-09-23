package dev.optio.feature.reviews

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.Assignment
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.filled.ArrowDropDown
import androidx.compose.material.icons.outlined.Bolt
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewModelScope
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.IssueDetailRoute
import dev.optio.core.navigation.routes.TaskDetailRoute
import dev.optio.core.network.ApiClient
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.MarkdownText
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch

/** "Assign to Optio" from an issue (iOS `IssueDetailView` state). */
internal class IssueDetailViewModel(
    private val api: ApiClient,
    private val route: IssueDetailRoute,
) : ViewModel() {
    data class State(
        /** "" = the repo's default agent. */
        val agentType: String = "",
        val assigning: Boolean = false,
        val error: Throwable? = null,
        val createdTaskId: String? = null,
    )

    private val _state = MutableStateFlow(State())
    val state: StateFlow<State> = _state.asStateFlow()

    /** The issue can be assigned from here (GitHub / GitLab issue in a configured repo, no task yet). */
    val isAssignable: Boolean
        get() = (route.source == null || route.source == "github" || route.source == "gitlab") &&
            route.repoId != null && route.number != null && !route.assigned

    fun setAgentType(type: String) = _state.update { it.copy(agentType = type) }

    fun assign() {
        val number = route.number ?: return
        val repoId = route.repoId ?: return
        if (_state.value.assigning) return
        viewModelScope.launch {
            _state.update { it.copy(assigning = true, error = null) }
            try {
                val task = api.assignIssue(number, repoId, route.title, route.body.orEmpty(), _state.value.agentType.ifEmpty { null })
                _state.update { it.copy(createdTaskId = task.id) }
                IssueAssignments.publish(route.identity, task.id)
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                _state.update { it.copy(error = e) }
            } finally {
                _state.update { it.copy(assigning = false) }
            }
        }
    }
}

/** Read an issue, open it on its host, or create a Task from it ("Assign to Optio"). */
@Composable
internal fun IssueDetailScreen(route: IssueDetailRoute) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val model = viewModel(key = "issue-${route.identity}") { IssueDetailViewModel(api, route) }
    val state by model.state.collectAsStateWithLifecycle()
    IssueDetailContent(
        route = route,
        state = state,
        assignable = model.isAssignable,
        canMutate = Roles.canMutate,
        onBack = navigator::pop,
        onOpenExternal = { route.url?.let(navigator::openExternal) },
        onAgentType = model::setAgentType,
        onAssign = model::assign,
        onOpenTask = { navigator.push(TaskDetailRoute(it)) },
    )
}

@Composable
internal fun IssueDetailContent(
    route: IssueDetailRoute,
    state: IssueDetailViewModel.State,
    assignable: Boolean,
    canMutate: Boolean,
    onBack: () -> Unit = {},
    onOpenExternal: () -> Unit = {},
    onAgentType: (String) -> Unit = {},
    onAssign: () -> Unit = {},
    onOpenTask: (String) -> Unit = {},
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val source = route.source
    val hostName = when (source) {
        null, "github" -> "GitHub"
        "gitlab" -> "GitLab"
        else -> source.replaceFirstChar { it.uppercase() }
    }
    Scaffold(
        modifier = Modifier.testTag("issue-detail"),
        containerColor = colors.page,
        topBar = {
            TopAppBar(
                title = { Text(route.numberText.ifEmpty { "Issue" }) },
                navigationIcon = {
                    IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                        Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                    }
                },
            )
        },
    ) { padding ->
        LazyColumn(
            modifier = Modifier.fillMaxSize().readableWidth(),
            contentPadding = PaddingValues(top = padding.calculateTopPadding() + Spacing.s, bottom = padding.calculateBottomPadding() + Spacing.xl),
        ) {
            item {
                GroupedSection {
                    Text(route.title, style = type.body, color = colors.label, modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m))
                    Row(
                        Modifier.padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
                        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                        verticalAlignment = Alignment.CenterVertically,
                    ) {
                        if (route.numberText.isNotEmpty()) Text(route.numberText, style = type.monoFootnote, color = colors.secondaryLabel)
                        Text(route.repoName ?: route.source.orEmpty(), style = type.footnote, color = colors.secondaryLabel, maxLines = 1)
                        route.state?.let { StatusBadge(text = it, tone = if (it == "open") Tone.WORKING else Tone.IDLE) }
                    }
                    route.author?.let {
                        InsetDivider()
                        KeyValueRow("Author", "@$it")
                    }
                    route.assignee?.let {
                        InsetDivider()
                        KeyValueRow("Assignee", "@$it")
                    }
                    if (route.url != null) {
                        InsetDivider()
                        KeyValueRow("Open on $hostName", null, onClick = onOpenExternal, modifier = Modifier.testTag("open-external"), trailing = {
                            Icon(Icons.AutoMirrored.Outlined.OpenInNew, contentDescription = null, tint = colors.accent, modifier = Modifier.size(18.dp))
                        })
                    }
                }
            }
            route.body?.takeIf { it.isNotBlank() }?.let { body ->
                item {
                    GroupedSection(header = "Description") {
                        SelectionContainer(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m)) {
                            MarkdownText(body, style = type.callout)
                        }
                    }
                }
            }
            item {
                GroupedSection(header = "Optio") {
                    val taskId = state.createdTaskId ?: route.taskId
                    when {
                        taskId != null -> KeyValueRow(
                            label = if (state.createdTaskId != null) "Task created — open it" else "Open the task working on this issue",
                            value = null,
                            onClick = { onOpenTask(taskId) },
                            modifier = Modifier.testTag("open-task"), trailing = {
                            Icon(Icons.AutoMirrored.Outlined.Assignment, contentDescription = null, tint = colors.accent, modifier = Modifier.size(18.dp))
                        })
                        route.assigned || (state.createdTaskId != null) -> Text(
                            "Optio is working on this issue.",
                            style = type.footnote,
                            color = colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                        assignable && canMutate -> {
                            AgentPicker(selection = state.agentType, onSelect = onAgentType)
                            InsetDivider()
                            Box(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m)) {
                                Button(onClick = onAssign, enabled = !state.assigning, modifier = Modifier.fillMaxWidth().testTag("assign-issue")) {
                                    if (state.assigning) {
                                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                                    } else {
                                        Icon(Icons.Outlined.Bolt, contentDescription = null, modifier = Modifier.size(18.dp))
                                        Spacer(Modifier.width(Spacing.s))
                                        Text("Assign to Optio")
                                    }
                                }
                            }
                        }
                        assignable -> Text(
                            "Viewers can't assign issues.",
                            style = type.footnote,
                            color = colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                        else -> Text(
                            "External tracker tickets are picked up automatically by the ticket-sync worker.",
                            style = type.footnote,
                            color = colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m),
                        )
                    }
                    state.error?.let { ErrorRow(error = it) }
                }
            }
        }
    }
}

/** "Agent: Repo default ▾" (iOS `Picker("Agent")`). */
@Composable
private fun AgentPicker(
    selection: String,
    onSelect: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val label = ReviewFormat.agentTypes.firstOrNull { it.first == selection }?.second ?: "Repo default"
    Box {
        KeyValueRow("Agent", label, onClick = { open = true }, modifier = Modifier.testTag("agent-picker"), trailing = {
            Icon(Icons.Filled.ArrowDropDown, contentDescription = null, tint = OptioTheme.colors.secondaryLabel)
        })
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            FilterItem("Repo default", selected = selection.isEmpty()) {
                open = false
                onSelect("")
            }
            ReviewFormat.agentTypes.forEach { (value, name) ->
                FilterItem(name, selected = selection == value) {
                    open = false
                    onSelect(value)
                }
            }
        }
    }
}
