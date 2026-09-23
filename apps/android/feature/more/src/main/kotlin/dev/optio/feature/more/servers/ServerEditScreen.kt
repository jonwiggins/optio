package dev.optio.feature.more.servers

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.data.LocalSessionStore
import dev.optio.core.data.ServerColor
import dev.optio.core.data.ServerProfile
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** The editable parts of a server profile (iOS `ServerEditView` drafts). */
data class ServerDraft(
    val name: String,
    val urlText: String,
    val color: ServerColor,
    val workspaceId: String?,
) {
    /** The address, normalised like sign-in (https when no scheme); null when it isn't one. */
    val editedUrl: String?
        get() = ServerProfile.normalizeUrl(urlText)

    /** [profile] with this draft applied (an empty name falls back to the host's first label). */
    fun applyTo(profile: ServerProfile): ServerProfile {
        val url = editedUrl ?: profile.url
        val trimmed = name.trim()
        return profile.copy(
            name = trimmed.ifEmpty { ServerProfile.defaultName(url) },
            url = url,
            color = color,
            workspaceId = workspaceId,
        )
    }

    companion object {
        fun of(profile: ServerProfile) = ServerDraft(profile.name, profile.url, profile.color, profile.workspaceId)
    }
}

/** `ServerEditRoute(id)` (iOS `ServerEditView`: "Edit Server"). */
@Composable
fun ServerEditScreen(serverId: String) {
    val session = LocalSessionStore.current
    val navigator = LocalNavigator.current
    val servers by session.servers.collectAsStateWithLifecycle()
    val profile = servers.firstOrNull { it.id == serverId }
    val viewModel = viewModel(key = "server-edit-$serverId") { ServerEditViewModel(session, serverId) }
    val workspaces by viewModel.workspaces.collectAsStateWithLifecycle()
    // Forgotten elsewhere (or never paired): nothing to edit.
    LaunchedEffect(profile == null) { if (profile == null) navigator.pop() }
    if (profile == null) return
    var draft by rememberSaveable(serverId, stateSaver = ServerDraftSaver) { mutableStateOf(ServerDraft.of(profile)) }
    MoreScaffold(
        "Edit Server",
        actions = {
            TextButton(
                onClick = { viewModel.save(draft.applyTo(profile)) { navigator.pop() } },
                enabled = draft.editedUrl != null,
                modifier = Modifier.testTag("server-save"),
            ) { Text("Save", style = OptioTheme.type.body.semibold()) }
        },
    ) { padding ->
        ServerEditContent(
            draft = draft,
            workspaces = workspaces,
            contentPadding = padding,
            onDraft = { draft = it },
            onForget = { viewModel.forget { navigator.pop() } },
        )
    }
}

/** The editor, stateless. */
@Composable
fun ServerEditContent(
    draft: ServerDraft,
    workspaces: List<WorkspaceRow>?,
    contentPadding: PaddingValues,
    onDraft: (ServerDraft) -> Unit,
    onForget: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = OptioTheme.colors
    val confirm = rememberConfirmState()
    val urlValid = draft.editedUrl != null
    LazyColumn(modifier.fillMaxSize().testTag("server-edit"), contentPadding = contentPadding) {
        groupedItem("name", header = "Name", footer = "Shown in the switcher, on the Overview and in widget sections.") {
            OutlinedTextField(
                value = draft.name,
                onValueChange = { onDraft(draft.copy(name = it)) },
                placeholder = { Text("MacBook Pro") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
                modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("server-name"),
            )
        }
        item(key = "address") {
            Column {
                GroupedSection(header = "Address") {
                    OutlinedTextField(
                        value = draft.urlText,
                        onValueChange = { onDraft(draft.copy(urlText = it)) },
                        placeholder = { Text("http://laptop.tailnet.ts.net:30400") },
                        singleLine = true,
                        isError = !urlValid,
                        textStyle = OptioTheme.type.monoBody,
                        keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                        modifier = Modifier.fillMaxWidth().padding(Spacing.m).testTag("server-url"),
                    )
                }
                Text(
                    if (urlValid) "The stored token is kept; change it by adding the server again." else "Enter the server address, including the port if it isn't 443.",
                    style = OptioTheme.type.footnote,
                    color = if (urlValid) colors.secondaryLabel else colors.red,
                    modifier = Modifier.padding(start = Spacing.l + Spacing.l, end = Spacing.l + Spacing.l, top = Spacing.s),
                )
            }
        }
        groupedItem("colour", header = "Colour", footer = "Marks this server's items in widgets, the Watch notification and the switcher.") {
            ServerColorPicker(selection = draft.color, onSelect = { onDraft(draft.copy(color = it)) })
        }
        groupedItem(
            "workspace",
            header = "Workspace",
            footer = "Requests to this server use this workspace. Default follows your account's current workspace there.",
        ) {
            WorkspaceOverridePicker(
                selection = draft.workspaceId,
                workspaces = workspaces,
                onSelect = { onDraft(draft.copy(workspaceId = it)) },
            )
        }
        groupedItem("forget") {
            SettingsRow(
                "Forget this server",
                icon = Icons.Outlined.Delete,
                tint = colors.red,
                chevron = false,
                onClick = {
                    confirm.ask(
                        title = "Forget ${draft.name.ifBlank { "this server" }}?",
                        message = "Its access token is removed from this phone.",
                        confirmLabel = "Forget server",
                        destructive = true,
                        onConfirm = onForget,
                    )
                },
                modifier = Modifier.testTag("server-forget"),
            )
        }
        bottomSpacer()
    }
    ConfirmHost(confirm)
}

/** Swatches for [ServerColor] (iOS `ServerColorPicker`). */
@Composable
fun ServerColorPicker(
    selection: ServerColor,
    onSelect: (ServerColor) -> Unit,
    modifier: Modifier = Modifier,
) {
    val haptics = LocalHapticFeedback.current
    Row(
        modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
        horizontalArrangement = Arrangement.spacedBy(14.dp),
    ) {
        ServerColor.entries.forEach { color ->
            val selected = color == selection
            Box(
                Modifier
                    .size(28.dp)
                    .clip(CircleShape)
                    .background(Color(color.argb))
                    .selectable(selected = selected, role = Role.RadioButton) {
                        if (!selected) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                        onSelect(color)
                    }
                    .semantics { contentDescription = color.label }
                    .testTag("color-${color.raw}"),
                contentAlignment = Alignment.Center,
            ) {
                if (selected) Icon(Icons.Filled.Check, contentDescription = null, tint = Color.White, modifier = Modifier.size(16.dp))
            }
        }
    }
}

/** Default, or one of the workspaces this server's token belongs to; an unknown stored id stays listed. */
@Composable
private fun WorkspaceOverridePicker(
    selection: String?,
    workspaces: List<WorkspaceRow>?,
    onSelect: (String?) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val known = workspaces.orEmpty()
    val label = when {
        selection == null -> "Default"
        else -> known.firstOrNull { it.id == selection }?.displayName ?: selection
    }
    Row(Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.s), verticalAlignment = Alignment.CenterVertically) {
        Text("Workspace", style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
        Box {
            TextButton(onClick = { open = true }, enabled = workspaces != null || selection != null, modifier = Modifier.testTag("server-workspace")) {
                Text(label, maxLines = 1, overflow = TextOverflow.MiddleEllipsis, modifier = Modifier.padding(end = 2.dp))
                Icon(Icons.Filled.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                val options = listOf<Pair<String?, String>>(null to "Default") +
                    known.map { it.id to it.displayName } +
                    (if (selection != null && known.none { it.id == selection }) listOf(selection to selection) else emptyList())
                options.forEach { (id, name) ->
                    DropdownMenuItem(
                        text = { Text(name) },
                        trailingIcon = if (id == selection) {
                            { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                        } else {
                            null
                        },
                        onClick = {
                            open = false
                            onSelect(id)
                        },
                    )
                }
            }
        }
    }
}

/** Saves the draft across rotation (names, addresses and colours are not secrets). */
internal val ServerDraftSaver = listSaver<ServerDraft, String?>(
    save = { listOf(it.name, it.urlText, it.color.raw, it.workspaceId) },
    restore = { ServerDraft(it[0] ?: "", it[1] ?: "", ServerColor.fromRaw(it[2]) ?: ServerColor.SLATE, it[3]) },
)
