package dev.optio.feature.library

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRowDefaults
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing

/** What the MCP server form holds (iOS `McpServerSheet` state). */
data class McpServerDraft(
    val name: String = "",
    val command: String = "",
    val args: String = "",
    val env: String = "",
    val installCommand: String = "",
) {
    /** iOS: Add is disabled until there is a name and a command. */
    val canSave: Boolean
        get() = name.isNotEmpty() && command.isNotEmpty()

    /** The request: args one per line, env `KEY=value` lines, empty parts omitted. */
    fun input(): McpServerInput = McpServerInput(
        name = name.trim(),
        command = command.trim(),
        args = parseLines(args).ifEmpty { null },
        env = parseKeyValueLines(env).ifEmpty { null },
        installCommand = installCommand.ifEmpty { null },
        repoUrl = null,
    )
}

/**
 * Add an MCP server, global or scoped to a repo (iOS `McpServerSheet`), as a bottom sheet. The
 * host's ViewModel saves ([onSave]) and closes it on success.
 */
@Composable
internal fun McpServerSheet(
    repoScoped: Boolean,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSave: (McpServerInput) -> Unit,
) {
    LibrarySheet(onDismissRequest = onDismiss, modifier = Modifier.testTag("mcp-sheet")) {
        McpServerForm(repoScoped = repoScoped, saving = saving, onCancel = onDismiss, onSave = onSave)
    }
}

/** The MCP server form (the sheet's content, stateless apart from what is typed). */
@Composable
internal fun McpServerForm(
    repoScoped: Boolean,
    saving: Boolean,
    onCancel: () -> Unit,
    onSave: (McpServerInput) -> Unit,
    modifier: Modifier = Modifier,
    initial: McpServerDraft = McpServerDraft(),
) {
    // Not saveable on purpose: env lines may hold literal secrets.
    var draft by remember { mutableStateOf(initial) }
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = Spacing.xl)) {
        SheetHeader(
            title = if (repoScoped) "Repo MCP Server" else "Global MCP Server",
            onCancel = onCancel,
            confirmLabel = "Add",
            confirmEnabled = draft.canSave,
            busy = saving,
            onConfirm = { onSave(draft.input()) },
        )
        GroupedCard {
            FormTextField(
                draft.name,
                { draft = draft.copy(name = it) },
                label = "Name",
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("mcp-name"),
            )
            InsetDivider()
            FormTextField(
                draft.command,
                { draft = draft.copy(command = it) },
                label = "Command",
                placeholder = "e.g. npx",
                mono = true,
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("mcp-command"),
            )
        }
        GroupedCard(header = "Args (one per line)") {
            FormTextField(
                draft.args,
                { draft = draft.copy(args = it) },
                label = null,
                placeholder = "-y\n@modelcontextprotocol/server-everything",
                mono = true,
                singleLine = false,
                minLines = 3,
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("mcp-args"),
            )
        }
        GroupedCard(header = "Env (KEY=value per line)", footer = "Use \$\u2060{{SECRET_NAME}} to reference an Optio secret.") {
            FormTextField(
                draft.env,
                { draft = draft.copy(env = it) },
                label = null,
                placeholder = "API_KEY=\${{MY_SECRET}}",
                mono = true,
                singleLine = false,
                minLines = 3,
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("mcp-env"),
            )
        }
        GroupedCard(header = "Install command (optional)") {
            FormTextField(
                draft.installCommand,
                { draft = draft.copy(installCommand = it) },
                label = null,
                placeholder = "npm install -g …",
                mono = true,
                keyboardOptions = CodeKeyboard,
                modifier = Modifier.testTag("mcp-install"),
            )
        }
    }
}

/**
 * One MCP server (iOS: name, trailing badges or a toggle, then `command args…` in mono under it).
 * [trailing] holds the scope / state badges or the enable switch.
 */
@Composable
internal fun McpServerItem(
    server: McpServerRow,
    modifier: Modifier = Modifier,
    trailing: @Composable RowScope.() -> Unit = {},
) {
    val colors = OptioTheme.colors
    Column(
        modifier.fillMaxWidth().padding(OptioRowDefaults.ContentPadding).testTag("mcp-${server.id}"),
        verticalArrangement = Arrangement.spacedBy(2.dp),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            Text(
                server.name ?: server.id,
                style = OptioTheme.type.subheadline,
                color = colors.label,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f),
            )
            trailing()
        }
        if (server.commandLine.isNotEmpty()) {
            Text(
                server.commandLine,
                style = OptioTheme.type.monoCaption,
                color = colors.secondaryLabel,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
    }
}
