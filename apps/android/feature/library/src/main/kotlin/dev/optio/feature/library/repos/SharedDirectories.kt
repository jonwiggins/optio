package dev.optio.feature.library.repos

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.outlined.Refresh
import androidx.compose.material.icons.outlined.Storage
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateMapOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import dev.optio.core.network.ApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.components.metaText
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.isoInstant
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.library.ActionRow
import dev.optio.feature.library.CodeKeyboard
import dev.optio.feature.library.FormTextField
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.GroupedRow
import dev.optio.feature.library.LibraryList
import dev.optio.feature.library.LibraryScaffold
import dev.optio.feature.library.LibrarySheet
import dev.optio.feature.library.LibraryViewModel
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.ScreenEffects
import dev.optio.feature.library.libraryViewModel
import dev.optio.feature.library.SharedDirectoryInput
import dev.optio.feature.library.SharedDirectoryRow
import dev.optio.feature.library.SharedDirectoryRules
import dev.optio.feature.library.SheetHeader
import dev.optio.feature.library.StepperRow
import dev.optio.feature.library.SwipeToDelete
import dev.optio.feature.library.clearSharedDirectory
import dev.optio.feature.library.createSharedDirectory
import dev.optio.feature.library.deleteSharedDirectory
import dev.optio.feature.library.getRepo
import dev.optio.feature.library.groupFooter
import dev.optio.feature.library.groupedCard
import dev.optio.feature.library.groupedItems
import dev.optio.feature.library.listSharedDirectories
import dev.optio.feature.library.listTopSpace
import dev.optio.feature.library.loadStateItems
import dev.optio.feature.library.orNull
import dev.optio.feature.library.recycleMessage
import dev.optio.feature.library.recycleRepoPods
import dev.optio.feature.library.sharedDirectoryUsage
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.Job

/** A repo's shared cache directories and its pod count (the footer's volume maths). */
data class SharedDirectories(
    val directories: List<SharedDirectoryRow>,
    val maxPodInstances: Int = 1,
)

/** Shared cache directories of one repo (iOS `SharedDirectoriesModel`). */
class SharedDirectoriesViewModel(private val api: ApiClient, val repoId: String) : LibraryViewModel<SharedDirectories>() {
    /** "Check usage" results by directory id ("unavailable" when the server couldn't measure). */
    val usage = mutableStateMapOf<String, String>()

    /** The directory an action runs on (or [RECYCLE]); one at a time, like iOS. */
    var busyId by mutableStateOf<String?>(null)
        private set

    var adding by mutableStateOf(false)
        private set

    /** iOS passes `maxPodInstances` from the repo detail; the route only has the id, so read the repo. */
    override suspend fun fetch(): SharedDirectories = coroutineScope {
        val pods = async { orNull { api.getRepo(repoId).maxPodInstances } ?: 1 }
        SharedDirectories(api.listSharedDirectories(repoId), pods.await())
    }

    private fun run(id: String, block: suspend () -> Unit): Job? {
        if (busyId != null) return null
        busyId = id
        return action {
            try {
                block()
            } finally {
                busyId = null
            }
        }
    }

    fun checkUsage(dir: SharedDirectoryRow) = run(dir.id) {
        usage[dir.id] = api.sharedDirectoryUsage(repoId, dir.id) ?: "unavailable"
    }

    fun clear(dir: SharedDirectoryRow) = run(dir.id) {
        api.clearSharedDirectory(repoId, dir.id)
        toast("Cleared ${dir.name ?: "directory"}.")
        reloadQuietly()
    }

    fun delete(dir: SharedDirectoryRow) = run(dir.id) {
        api.deleteSharedDirectory(repoId, dir.id)
        usage.remove(dir.id)
        reloadQuietly()
    }

    fun recycle() = run(RECYCLE) {
        toast(recycleMessage(api.recycleRepoPods(repoId)))
    }

    /** Adds a directory; [onAdded] closes the sheet. */
    fun add(input: SharedDirectoryInput, onAdded: () -> Unit): Job? {
        if (adding) return null
        adding = true
        return action {
            try {
                api.createSharedDirectory(repoId, input)
                onAdded()
                toast("Added ${input.name}.")
                reloadQuietly()
            } finally {
                adding = false
            }
        }
    }

    companion object {
        const val RECYCLE = "recycle"
    }
}

/** iOS's footer: each directory is one PVC per pod instance. */
internal fun volumesFooter(maxPodInstances: Int): String {
    val instances = if (maxPodInstances == 1) "instance" else "instances"
    val volumes = if (maxPodInstances == 1) "volume" else "volumes"
    return "Each directory is a per-pod PVC; with $maxPodInstances pod $instances that is $maxPodInstances $volumes per directory. " +
        "Recycle pods after adding or removing one."
}

@Composable
internal fun SharedDirectoriesScreen(
    repoId: String,
    vm: SharedDirectoriesViewModel = libraryViewModel { SharedDirectoriesViewModel(it, repoId) },
) {
    val isAdmin = Roles.isAdmin
    val confirm = rememberConfirmState()
    var showAdd by rememberSaveable { mutableStateOf(false) }
    val state by vm.state.collectAsStateWithLifecycle()
    ScreenEffects(vm.events, onAppear = vm::onAppear)
    LibraryScaffold(
        title = "Shared directories",
        actions = {
            if (isAdmin) {
                IconButton(onClick = { showAdd = true }, modifier = Modifier.testTag("add-directory")) {
                    Icon(Icons.Filled.Add, contentDescription = "Add shared directory")
                }
            }
        },
    ) { padding ->
        SharedDirectoriesContent(
            state = state,
            usage = vm.usage,
            busyId = vm.busyId,
            isAdmin = isAdmin,
            onRefresh = vm::refresh,
            onCheckUsage = vm::checkUsage,
            onClear = { dir ->
                confirm.ask(
                    "Clear “${dir.name ?: ""}”?",
                    message = "Empties the persistent volume. Caches will rebuild on the next run.",
                    confirmLabel = "Clear contents",
                    destructive = true,
                ) { vm.clear(dir) }
            },
            onDelete = { dir ->
                confirm.ask(
                    "Delete “${dir.name ?: ""}”?",
                    message = "Removes the directory and its volume.",
                    confirmLabel = "Delete",
                    destructive = true,
                ) { vm.delete(dir) }
            },
            onRecycle = { confirm.ask("Recycle idle pods?", confirmLabel = "Recycle", onConfirm = vm::recycle) },
            contentPadding = padding,
        )
    }
    if (showAdd) {
        LibrarySheet(onDismissRequest = { showAdd = false }, modifier = Modifier.testTag("directory-sheet")) {
            NewSharedDirectoryForm(
                saving = vm.adding,
                onCancel = { showAdd = false },
                onSave = { input -> vm.add(input) { showAdd = false } },
            )
        }
    }
    ConfirmHost(confirm)
}

/** The shared directories list (stateless). */
@Composable
internal fun SharedDirectoriesContent(
    state: LoadState<SharedDirectories>,
    usage: Map<String, String>,
    busyId: String?,
    isAdmin: Boolean,
    onRefresh: () -> Unit,
    onCheckUsage: (SharedDirectoryRow) -> Unit,
    onClear: (SharedDirectoryRow) -> Unit,
    onDelete: (SharedDirectoryRow) -> Unit,
    onRecycle: () -> Unit,
    modifier: Modifier = Modifier,
    contentPadding: PaddingValues = PaddingValues(),
) {
    LibraryList(state, onRefresh, modifier, contentPadding, testTag = "shared-directories") {
        loadStateItems(state, what = "shared directories", onRetry = onRefresh) { data ->
            if (data.directories.isEmpty()) {
                item(key = "empty", contentType = "state") {
                    EmptyState(
                        title = "No shared directories",
                        icon = Icons.Outlined.Storage,
                        message = "Add a persistent cache (npm, pip, cargo…) to speed up agent pods.",
                    )
                }
            } else {
                listTopSpace()
                groupedItems(data.directories, key = { it.id }) { dir, position ->
                    GroupedRow(position) {
                        SwipeToDelete(enabled = isAdmin, onDelete = { onDelete(dir) }) {
                            SharedDirectoryItem(
                                dir = dir,
                                usage = usage[dir.id],
                                busy = busyId == dir.id,
                                actionsEnabled = busyId == null,
                                isAdmin = isAdmin,
                                onCheckUsage = { onCheckUsage(dir) },
                                onClear = { onClear(dir) },
                            )
                        }
                    }
                }
                groupFooter(volumesFooter(data.maxPodInstances), key = "footer")
                if (isAdmin) {
                    groupedCard(key = "recycle") {
                        ActionRow(
                            "Recycle pods to apply mounts",
                            onClick = onRecycle,
                            icon = Icons.Outlined.Refresh,
                            enabled = busyId == null,
                            busy = busyId == SharedDirectoriesViewModel.RECYCLE,
                            modifier = Modifier.testTag("recycle-pods"),
                        )
                    }
                }
            }
        }
    }
}

/** One directory (iOS `row(_:)`): name + size, mount path, description, usage / cleared / mounted, admin buttons. */
@Composable
internal fun SharedDirectoryItem(
    dir: SharedDirectoryRow,
    usage: String?,
    busy: Boolean,
    actionsEnabled: Boolean,
    isAdmin: Boolean,
    onCheckUsage: () -> Unit,
    onClear: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val now = rememberNow()
    Column(
        modifier
            .fillMaxWidth()
            // The admin buttons carry their own touch padding: less air under them.
            .padding(start = Spacing.l, end = Spacing.l, top = Spacing.m, bottom = if (isAdmin) Spacing.xs else Spacing.m)
            .testTag("directory-${dir.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(
                dir.name ?: dir.id,
                style = OptioTheme.type.headline,
                color = colors.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            if (busy) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp)
            Text("${dir.sizeGi ?: 0} Gi", style = OptioTheme.type.caption, color = colors.secondaryLabel)
        }
        Text(
            "${dir.mountLocation ?: "workspace"}/${dir.mountSubPath.orEmpty()}",
            style = OptioTheme.type.monoCaption,
            color = colors.secondaryLabel,
            maxLines = 1,
            overflow = TextOverflow.StartEllipsis,
        )
        dir.description?.takeIf { it.isNotEmpty() }?.let {
            Text(it, style = OptioTheme.type.footnote, color = colors.secondaryLabel)
        }
        val stats = metaText(
            usage?.let { "Usage: $it" },
            dir.lastClearedAt?.isoInstant()?.let { "Cleared ${it.relativeDescription(now)}" },
            dir.lastMountedAt?.isoInstant()?.let { "Mounted ${it.relativeDescription(now)}" },
        )
        if (stats != null) Text(stats, style = OptioTheme.type.caption2, color = colors.tertiaryLabel)
        if (isAdmin) {
            Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.SpaceBetween) {
                TextButton(onClick = onCheckUsage, enabled = actionsEnabled, contentPadding = PaddingValues(0.dp), modifier = Modifier.testTag("check-usage")) {
                    Text("Check usage", style = OptioTheme.type.footnote.semibold())
                }
                TextButton(onClick = onClear, enabled = actionsEnabled, contentPadding = PaddingValues(0.dp), modifier = Modifier.testTag("clear-directory")) {
                    Text("Clear", style = OptioTheme.type.footnote.semibold(), color = if (actionsEnabled) colors.red else colors.tertiaryLabel)
                }
            }
        }
    }
}

/** What the new-directory form holds (iOS `NewSharedDirectorySheet`). */
data class SharedDirectoryDraft(
    val preset: String = "",
    val name: String = "",
    val description: String = "",
    val mountLocation: String = "home",
    val mountSubPath: String = "",
    val sizeGi: Int = 10,
) {
    /** Picking a preset fills name, home-relative sub-path and description (iOS `onChange(of: preset)`). */
    fun withPreset(label: String): SharedDirectoryDraft {
        val hit = SharedDirectoryRules.presets.firstOrNull { it.first == label } ?: return copy(preset = label)
        return copy(preset = label, name = hit.second, mountSubPath = hit.third, mountLocation = "home", description = "${hit.first} cache")
    }

    val nameProblem: String?
        get() = SharedDirectoryRules.nameProblem(name)

    val subPathProblem: String?
        get() = SharedDirectoryRules.subPathProblem(mountSubPath.trim())

    /** iOS disables Add until name and sub-path are set; the API's rules are checked here too. */
    val canSave: Boolean
        get() = name.isNotEmpty() && mountSubPath.isNotEmpty() && nameProblem == null && subPathProblem == null

    fun input(): SharedDirectoryInput = SharedDirectoryInput(
        name = name.trim(),
        description = description.ifEmpty { null },
        mountLocation = mountLocation,
        mountSubPath = mountSubPath.trim(),
        sizeGi = sizeGi,
    )
}

internal val MountLocations = listOf("home" to "Home (~)", "workspace" to "Workspace")

/** The new shared directory form (the sheet's content). */
@Composable
internal fun NewSharedDirectoryForm(
    saving: Boolean,
    onCancel: () -> Unit,
    onSave: (SharedDirectoryInput) -> Unit,
    modifier: Modifier = Modifier,
    initial: SharedDirectoryDraft = SharedDirectoryDraft(),
) {
    var draft by remember { mutableStateOf(initial) }
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = Spacing.xl)) {
        SheetHeader(
            title = "New Shared Directory",
            onCancel = onCancel,
            confirmLabel = "Add",
            confirmEnabled = draft.canSave,
            busy = saving,
            onConfirm = { onSave(draft.input()) },
        )
        GroupedCard {
            PickerRow(
                "Preset",
                listOf("" to "Custom") + SharedDirectoryRules.presets.map { it.first to "${it.first} — ${it.third}" },
                draft.preset,
                { draft = draft.withPreset(it) },
                modifier = Modifier.testTag("directory-preset"),
            )
        }
        GroupedCard {
            FormTextField(
                draft.name,
                { draft = draft.copy(name = it) },
                label = "Name (slug)",
                keyboardOptions = CodeKeyboard,
                supportingText = draft.nameProblem,
                isError = draft.nameProblem != null,
                modifier = Modifier.testTag("directory-name"),
            )
            InsetDivider()
            FormTextField(draft.description, { draft = draft.copy(description = it) }, label = "Description (optional)")
            InsetDivider()
            PickerRow("Mount location", MountLocations, draft.mountLocation, { draft = draft.copy(mountLocation = it) })
            InsetDivider()
            FormTextField(
                draft.mountSubPath,
                { draft = draft.copy(mountSubPath = it) },
                label = "Sub-path",
                placeholder = "e.g. .npm",
                mono = true,
                keyboardOptions = CodeKeyboard,
                supportingText = draft.subPathProblem,
                isError = draft.subPathProblem != null,
                modifier = Modifier.testTag("directory-subpath"),
            )
            InsetDivider()
            StepperRow("Size", draft.sizeGi, { draft = draft.copy(sizeGi = it) }, range = 1..100, valueText = "${draft.sizeGi} Gi")
        }
    }
}
