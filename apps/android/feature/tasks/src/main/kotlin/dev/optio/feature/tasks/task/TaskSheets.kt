package dev.optio.feature.tasks.task

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Search
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.SkeletonRows
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.ProvideElevatedSurfaces
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.tasks.common.FormPicker
import dev.optio.feature.tasks.common.FormSwitch
import dev.optio.feature.tasks.common.FormTextField
import dev.optio.feature.tasks.data.TaskRow
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch

/** Subtask kinds (iOS `CreateSubtaskSheet` picker). */
val SUBTASK_TYPES: List<Pair<String, String>> = listOf(
    "child" to "Child task",
    "step" to "Sequential step",
    "review" to "Code review",
)

/** A sheet header: Cancel · title · the confirm button. */
@Composable
internal fun SheetHeader(
    title: String,
    confirmLabel: String?,
    canConfirm: Boolean,
    busy: Boolean,
    onCancel: () -> Unit,
    onConfirm: () -> Unit,
    confirmTag: String = "sheet-confirm",
) {
    Row(verticalAlignment = Alignment.CenterVertically) {
        TextButton(onClick = onCancel, enabled = !busy) { Text("Cancel") }
        Text(title, style = OptioTheme.type.headline, color = OptioTheme.colors.label, modifier = Modifier.weight(1f).padding(horizontal = Spacing.s))
        if (confirmLabel != null) {
            Button(onClick = onConfirm, enabled = canConfirm && !busy, modifier = Modifier.testTag(confirmTag)) { Text(confirmLabel) }
        }
    }
}

/**
 * New subtask (iOS `CreateSubtaskSheet`): title, type (child / sequential step / code review),
 * "Blocks parent until done", and the prompt. [onCreate] throws to keep the sheet open with the error.
 */
@Composable
fun CreateSubtaskSheet(
    onCreate: suspend (title: String, prompt: String, taskType: String, blocksParent: Boolean) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var title by remember { mutableStateOf("") }
    var prompt by remember { mutableStateOf("") }
    var taskType by remember { mutableStateOf("child") }
    var blocksParent by remember { mutableStateOf(false) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.testTag("create-subtask-sheet")) {
        ProvideElevatedSurfaces {
            Column(
                Modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(horizontal = Spacing.l).navigationBarsPadding().imePadding(),
                verticalArrangement = Arrangement.spacedBy(Spacing.m),
            ) {
                SheetHeader(
                    title = "New subtask",
                    confirmLabel = "Create",
                    canConfirm = title.isNotBlank() && prompt.isNotBlank(),
                    busy = saving,
                    onCancel = onDismiss,
                    onConfirm = {
                        saving = true
                        error = null
                        scope.launch {
                            try {
                                onCreate(title, prompt, taskType, blocksParent)
                                sheetState.hide()
                                onDismiss()
                            } catch (e: CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                error = e
                            } finally {
                                saving = false
                            }
                        }
                    },
                    confirmTag = "subtask-create",
                )
                FormTextField(value = title, onValueChange = { title = it }, label = "Title", testTag = "subtask-title")
                FormPicker(label = "Type", selection = taskType, options = SUBTASK_TYPES, onSelect = { taskType = it }, testTag = "subtask-type")
                FormSwitch(label = "Blocks parent until done", checked = blocksParent, onCheckedChange = { blocksParent = it }, testTag = "subtask-blocks")
                FormTextField(
                    value = prompt,
                    onValueChange = { prompt = it },
                    label = "Prompt",
                    singleLine = false,
                    minLines = 5,
                    testTag = "subtask-prompt",
                )
                error?.let { ErrorRow(it, contentPadding = PaddingValues(0.dp)) }
                Spacer(Modifier.height(Spacing.l))
            }
        }
    }
}

/**
 * Add dependency (iOS `AddDependencySheet`): search tasks, tap one to make this task wait for it.
 * [search] excludes this task and its current dependencies; [onPick] throws to keep the sheet open.
 */
@Composable
fun AddDependencySheet(
    search: suspend (String) -> List<TaskRow>,
    onPick: suspend (String) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var query by remember { mutableStateOf("") }
    var results by remember { mutableStateOf<LoadState<List<TaskRow>>>(LoadState.Loading()) }
    var adding by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<Throwable?>(null) }
    LaunchedEffect(query) {
        if (query.isNotEmpty()) delay(300) // debounce typing
        results = LoadState.Loading(results.value)
        results = try {
            LoadState.Loaded(search(query))
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            LoadState.Failed(e, results.value)
        }
    }
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.testTag("add-dependency-sheet")) {
        ProvideElevatedSurfaces {
            Column(Modifier.fillMaxWidth().fillMaxHeight(0.9f).imePadding()) {
                Column(Modifier.padding(horizontal = Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    SheetHeader(title = "Add dependency", confirmLabel = null, canConfirm = false, busy = adding, onCancel = onDismiss, onConfirm = {})
                    OutlinedTextField(
                        value = query,
                        onValueChange = { query = it },
                        placeholder = { Text("Search tasks") },
                        leadingIcon = { Icon(Icons.Outlined.Search, contentDescription = null) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth().testTag("dependency-search"),
                    )
                    error?.let { ErrorRow(it, contentPadding = PaddingValues(0.dp)) }
                }
                val list = results.value
                when {
                    list == null && results is LoadState.Failed -> ErrorRow((results as LoadState.Failed).error, what = "tasks")
                    list == null -> SkeletonRows()
                    list.isEmpty() -> Text(
                        if (query.isEmpty()) "No tasks" else "No tasks match “$query”",
                        style = OptioTheme.type.body,
                        color = OptioTheme.colors.secondaryLabel,
                        modifier = Modifier.padding(Spacing.l),
                    )
                    else -> LazyColumn(Modifier.fillMaxWidth().weight(1f).navigationBarsPadding()) {
                        items(list, key = { it.id }) { task ->
                            TaskRowView(task, onClick = {
                                if (adding) return@TaskRowView
                                adding = true
                                error = null
                                scope.launch {
                                    try {
                                        onPick(task.id)
                                        sheetState.hide()
                                        onDismiss()
                                    } catch (e: CancellationException) {
                                        throw e
                                    } catch (e: Exception) {
                                        error = e
                                    } finally {
                                        adding = false
                                    }
                                }
                            })
                            InsetDivider()
                        }
                    }
                }
            }
        }
    }
}
