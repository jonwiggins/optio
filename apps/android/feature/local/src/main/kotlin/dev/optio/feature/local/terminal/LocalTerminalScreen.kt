package dev.optio.feature.local.terminal

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.outlined.OpenInNew
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.DriveFileRenameOutline
import androidx.compose.material.icons.outlined.HighlightOff
import androidx.compose.material.icons.outlined.Keyboard
import androidx.compose.material.icons.outlined.MoreVert
import androidx.compose.material.icons.outlined.NotificationsActive
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material.icons.outlined.Replay
import androidx.compose.material.icons.outlined.Snooze
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleStartEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.LocalHost
import dev.optio.core.model.LocalTerminal
import dev.optio.core.model.LocalTerminalState
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalEventHub
import dev.optio.core.terminal.TerminalState
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ErrorRow
import dev.optio.core.ui.components.StateDot
import dev.optio.core.ui.components.copyToClipboard
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.local.model.LocalPresentation
import dev.optio.feature.local.model.LocalSessionView
import dev.optio.feature.local.snooze.SnoozeStore
import dev.optio.feature.local.stream.LocalTerminalStream
import dev.optio.feature.local.transcript.LocalTranscriptModel
import dev.optio.feature.local.ui.actionFailure
import java.time.Instant
import kotlinx.coroutines.launch

/**
 * `LocalTerminalRoute`: the focus view of one Optio Local terminal (iOS `LocalTerminalScreen`,
 * web `/local/:id`). A header with state and the usage pill, then one of two faces: the
 * **Transcript** (the agent's conversation, with a composer) whenever there is one, else the
 * **Screen** (the live terminal). [compose] (`optio://local/<id>?compose=1`) lands with the composer
 * focused.
 */
@Composable
fun LocalTerminalScreen(
    terminalId: String,
    compose: Boolean = false,
) {
    val api = LocalApiClient.current
    val hub = LocalEventHub.current
    val context = LocalContext.current
    val vm: LocalTerminalViewModel =
        viewModel(key = "local-terminal-$terminalId") {
            LocalTerminalViewModel(
                api = api,
                terminalId = terminalId,
                compose = compose,
                eventHub = hub,
                snoozeStore = SnoozeStore.create(context),
            )
        }
    LifecycleStartEffect(vm) {
        vm.attach()
        onStopOrDispose { vm.detach() }
    }
    val navigator = LocalNavigator.current
    val toaster = LocalToaster.current
    LaunchedEffect(vm) {
        vm.events.collect { event ->
            when (event) {
                is LocalTerminalViewModel.Event.Toast -> toaster.toast(event.message, event.tone)
                is LocalTerminalViewModel.Event.Failed -> toaster.error(actionFailure(event.error, event.verb))
                LocalTerminalViewModel.Event.Closed -> navigator.pop()
                is LocalTerminalViewModel.Event.Open -> navigator.push(event.route)
            }
        }
    }

    val loadState by vm.terminal.collectAsStateWithLifecycle()
    val hosts by vm.hosts.collectAsStateWithLifecycle()
    val view by vm.sessionView.collectAsStateWithLifecycle()
    val transcript by vm.transcript.state.collectAsStateWithLifecycle()
    val stream by vm.streamState.collectAsStateWithLifecycle()
    val busy by vm.busy.collectAsStateWithLifecycle()
    val focusComposer by vm.focusComposer.collectAsStateWithLifecycle()
    val now = LocalClock.current.instant()

    LocalTerminalScaffold(
        loadState = loadState,
        hosts = hosts,
        view = view,
        transcript = transcript,
        stream = stream,
        screen = vm.screen,
        busy = busy,
        canMutate = Roles.canMutate,
        focusComposer = focusComposer,
        // Only while it sits in the needs-you queue (a finished, quiet run has nothing left to snooze).
        snoozedUntil =
            loadState.value?.takeIf(LocalPresentation::canSnooze)?.let { LocalPresentation.snoozedUntil(it, now) ?: vm.localSnoozeUntil() },
        actions =
            TerminalActions(
                onBack = navigator::pop,
                onRetry = vm::retry,
                onChooseView = vm::choose,
                onSend = vm::sendToAgent,
                onComposerFocused = vm::composerFocused,
                onClaim = vm::claim,
                onReconnect = vm::reconnect,
                onOpenLink = navigator::openExternal,
                onStart = vm::start,
                onResume = vm::resume,
                onKill = vm::kill,
                onDelete = vm::delete,
                onSnooze = vm::snooze,
                onUnsnooze = vm::unsnooze,
                onSendText = vm::sendViaRest,
                onRename = vm::rename,
            ),
    )
}

/** What the screen can do, bundled so the stateless scaffold stays readable (and screenshot-able). */
internal class TerminalActions(
    val onBack: () -> Unit = {},
    val onRetry: () -> Unit = {},
    val onChooseView: (LocalSessionView) -> Unit = {},
    val onSend: suspend (String) -> Unit = {},
    val onComposerFocused: () -> Unit = {},
    val onClaim: () -> Unit = {},
    val onReconnect: () -> Unit = {},
    val onOpenLink: (String) -> Unit = {},
    val onStart: () -> Unit = {},
    val onResume: () -> Unit = {},
    val onKill: (signal: String?) -> Unit = {},
    val onDelete: () -> Unit = {},
    val onSnooze: () -> Unit = {},
    val onUnsnooze: () -> Unit = {},
    val onSendText: (String) -> Unit = {},
    val onRename: (String) -> Unit = {},
)

/** The terminal screen for given state: top bar, header, and the face [view] picks. */
@Composable
internal fun LocalTerminalScaffold(
    loadState: LoadState<LocalTerminal>,
    hosts: List<LocalHost>,
    view: LocalSessionView?,
    transcript: LocalTranscriptModel.State,
    stream: LocalTerminalStream.State,
    screen: TerminalState,
    busy: Boolean,
    canMutate: Boolean,
    focusComposer: Boolean,
    snoozedUntil: Instant?,
    actions: TerminalActions,
) {
    val terminal = loadState.value
    var dialog by remember { mutableStateOf<TerminalDialog?>(null) }
    Scaffold(
        topBar = {
            TerminalTopBar(
                terminal = terminal,
                busy = busy,
                canMutate = canMutate,
                snoozed = snoozedUntil != null,
                actions = actions,
                onDialog = { dialog = it },
            )
        },
    ) { padding ->
        // Consumed, so the faces' keyboard padding doesn't count the navigation bar twice.
        Box(Modifier.fillMaxSize().padding(padding).consumeWindowInsets(padding)) {
            when {
                terminal != null ->
                    TerminalBody(
                        terminal = terminal,
                        hosts = hosts,
                        view = view,
                        transcript = transcript,
                        stream = stream,
                        screen = screen,
                        canMutate = canMutate,
                        focusComposer = focusComposer,
                        snoozedUntil = snoozedUntil,
                        actions = actions,
                    )
                loadState is LoadState.Failed ->
                    LazyColumn(Modifier.fillMaxSize()) {
                        item { ErrorRow(error = loadState.error, what = "terminal", retry = actions.onRetry) }
                    }
                else ->
                    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator(Modifier.size(28.dp), strokeWidth = 2.dp)
                    }
            }
        }
    }
    if (terminal != null) {
        TerminalDialogs(terminal, dialog, onDismiss = { dialog = null }, actions = actions)
    }
}

@Composable
private fun TerminalBody(
    terminal: LocalTerminal,
    hosts: List<LocalHost>,
    view: LocalSessionView?,
    transcript: LocalTranscriptModel.State,
    stream: LocalTerminalStream.State,
    screen: TerminalState,
    canMutate: Boolean,
    focusComposer: Boolean,
    snoozedUntil: Instant?,
    actions: TerminalActions,
) {
    Column(Modifier.fillMaxSize()) {
        TerminalHeader(
            terminal = terminal,
            hosts = hosts,
            view = view,
            hasTranscript = transcript.hasEntries,
            snoozedUntil = snoozedUntil,
            onChooseView = actions.onChooseView,
            onOpenLink = actions.onOpenLink,
        )
        when (view) {
            null ->
                Box(Modifier.fillMaxSize().testTag("face-loading"), contentAlignment = Alignment.Center) {
                    CircularProgressIndicator(Modifier.size(24.dp), strokeWidth = 2.dp, color = OptioTheme.colors.secondaryLabel)
                }
            LocalSessionView.TRANSCRIPT ->
                TranscriptFace(
                    terminal = terminal,
                    entries = transcript.entries,
                    canSend = canMutate && terminal.state == LocalTerminalState.RUNNING,
                    autofocus = focusComposer,
                    onSend = actions.onSend,
                    onComposerFocused = actions.onComposerFocused,
                )
            LocalSessionView.SCREEN -> {
                // `?compose=1` on a session without a conversation: the terminal takes the keyboard (a claim).
                if (focusComposer && canMutate && !LocalPresentation.isDead(terminal)) {
                    LaunchedEffect(Unit) {
                        kotlinx.coroutines.delay(600)
                        screen.focus()
                        actions.onComposerFocused()
                    }
                }
                ScreenFace(
                    terminal = terminal,
                    screen = screen,
                    stream = stream,
                    canType = canMutate,
                    onClaim = actions.onClaim,
                    onReconnect = actions.onReconnect,
                    onStart = actions.onStart,
                )
            }
        }
    }
}

// region Top bar

@Composable
private fun TerminalTopBar(
    terminal: LocalTerminal?,
    busy: Boolean,
    canMutate: Boolean,
    snoozed: Boolean,
    actions: TerminalActions,
    onDialog: (TerminalDialog) -> Unit,
) {
    TopAppBar(
        navigationIcon = {
            IconButton(onClick = actions.onBack, modifier = Modifier.testTag("back")) {
                Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
            }
        },
        title = {
            if (terminal == null) {
                Text("Terminal", maxLines = 1)
            } else {
                Column {
                    Text(terminal.title, style = OptioTheme.type.subheadline.semibold(), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    val waits = LocalPresentation.waitsOnYou(terminal)
                    Row(horizontalArrangement = Arrangement.spacedBy(5.dp), verticalAlignment = Alignment.CenterVertically) {
                        LocalPresentation.rowTone(terminal)?.let { StateDot(it, size = 6.dp) }
                        Text(
                            if (waits) LocalPresentation.waitingLabel(terminal) else LocalPresentation.stateLabel(terminal),
                            style = OptioTheme.type.caption2,
                            color = if (waits) Tone.ACCENT.textColor else OptioTheme.colors.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag("terminal-status"),
                        )
                    }
                }
            }
        },
        actions = {
            if (terminal != null) {
                if (busy) {
                    CircularProgressIndicator(Modifier.padding(horizontal = 12.dp).size(20.dp), strokeWidth = 2.dp)
                } else if (canMutate) {
                    PrimaryAction(terminal, snoozed, actions)
                }
                TerminalMenu(terminal, canMutate, snoozed, actions, onDialog)
            }
        },
    )
}

/** The one action worth a button for the terminal's state: Start, Resume chat, or Later. */
@Composable
private fun PrimaryAction(
    terminal: LocalTerminal,
    snoozed: Boolean,
    actions: TerminalActions,
) {
    when {
        LocalPresentation.canStart(terminal) ->
            IconButton(onClick = actions.onStart, modifier = Modifier.testTag("action-start")) {
                Icon(Icons.Outlined.PlayArrow, contentDescription = "Start")
            }
        LocalPresentation.canResume(terminal) ->
            IconButton(onClick = actions.onResume, modifier = Modifier.testTag("action-resume")) {
                Icon(Icons.Outlined.Replay, contentDescription = "Resume chat")
            }
        LocalPresentation.canSnooze(terminal) && !snoozed ->
            IconButton(onClick = actions.onSnooze, modifier = Modifier.testTag("action-later")) {
                Icon(Icons.Outlined.Snooze, contentDescription = "Later")
            }
    }
}

@Composable
private fun TerminalMenu(
    terminal: LocalTerminal,
    canMutate: Boolean,
    snoozed: Boolean,
    actions: TerminalActions,
    onDialog: (TerminalDialog) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("terminal-menu")) {
            Icon(Icons.Outlined.MoreVert, contentDescription = "More")
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            fun item(
                label: String,
                icon: androidx.compose.ui.graphics.vector.ImageVector,
                tag: String,
                destructive: Boolean = false,
                action: () -> Unit,
            ): @Composable () -> Unit =
                {
                    DropdownMenuItem(
                        text = { Text(label, color = if (destructive) MaterialTheme.colorScheme.error else androidx.compose.ui.graphics.Color.Unspecified) },
                        leadingIcon = { Icon(icon, contentDescription = null, tint = if (destructive) MaterialTheme.colorScheme.error else OptioTheme.colors.secondaryLabel) },
                        onClick = {
                            open = false
                            action()
                        },
                        modifier = Modifier.testTag(tag),
                    )
                }
            if (canMutate) {
                if (LocalPresentation.canStart(terminal)) item("Start", Icons.Outlined.PlayArrow, "menu-start", action = actions.onStart)()
                if (LocalPresentation.canResume(terminal)) item("Resume chat", Icons.Outlined.Replay, "menu-resume", action = actions.onResume)()
                if (snoozed) {
                    item("Back in the queue now", Icons.Outlined.NotificationsActive, "menu-unsnooze", action = actions.onUnsnooze)()
                } else if (LocalPresentation.canSnooze(terminal)) {
                    item("Later (15 min)", Icons.Outlined.Snooze, "menu-later", action = actions.onSnooze)()
                }
                if (terminal.state == LocalTerminalState.RUNNING) {
                    item("Send text…", Icons.Outlined.Keyboard, "menu-send-text") { onDialog(TerminalDialog.SEND_TEXT) }()
                }
                item("Rename…", Icons.Outlined.DriveFileRenameOutline, "menu-rename") { onDialog(TerminalDialog.RENAME) }()
                if (LocalPresentation.canKill(terminal)) {
                    item("Kill…", Icons.Outlined.HighlightOff, "menu-kill", destructive = true) { onDialog(TerminalDialog.KILL) }()
                }
                if (LocalPresentation.canDelete(terminal)) {
                    item("Delete…", Icons.Outlined.Delete, "menu-delete", destructive = true) { onDialog(TerminalDialog.DELETE) }()
                }
            }
            val links = LocalPresentation.workLinks(terminal)
            if (links.isNotEmpty()) {
                if (canMutate) HorizontalDivider()
                links.forEach { link ->
                    item(link.label, Icons.AutoMirrored.Outlined.OpenInNew, "menu-link") { actions.onOpenLink(link.url) }()
                }
            }
            HorizontalDivider()
            item("Copy directory", Icons.Outlined.ContentCopy, "menu-copy-dir") {
                scope.launch {
                    copyToClipboard(clipboard, terminal.dir)
                    toaster.success("Copied")
                }
            }()
            DropdownMenuItem(
                text = {
                    Column(verticalArrangement = Arrangement.spacedBy(2.dp)) {
                        Text(terminal.dir, style = OptioTheme.type.caption, fontFamily = FontFamily.Monospace, color = OptioTheme.colors.secondaryLabel)
                        terminal.command?.takeIf { it.isNotEmpty() }?.let {
                            Text(it, style = OptioTheme.type.caption, fontFamily = FontFamily.Monospace, color = OptioTheme.colors.tertiaryLabel)
                        }
                    }
                },
                onClick = {},
                enabled = false,
            )
        }
    }
}

// endregion

// region Dialogs

internal enum class TerminalDialog { KILL, DELETE, SEND_TEXT, RENAME }

@Composable
private fun TerminalDialogs(
    terminal: LocalTerminal,
    dialog: TerminalDialog?,
    onDismiss: () -> Unit,
    actions: TerminalActions,
) {
    when (dialog) {
        null -> Unit
        TerminalDialog.KILL ->
            AlertDialog(
                onDismissRequest = onDismiss,
                modifier = Modifier.testTag("kill-dialog"),
                title = { Text("Kill this terminal's process?") },
                text = { Text("Kill sends SIGTERM; Force kill sends SIGKILL.") },
                confirmButton = {
                    Row {
                        TextButton(
                            onClick = {
                                onDismiss()
                                actions.onKill("SIGKILL")
                            },
                            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                            modifier = Modifier.testTag("kill-force"),
                        ) { Text("Force kill") }
                        TextButton(
                            onClick = {
                                onDismiss()
                                actions.onKill(null)
                            },
                            colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                            modifier = Modifier.testTag("kill-term"),
                        ) { Text("Kill") }
                    }
                },
                dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("dismiss")) { Text("Cancel") } },
            )
        TerminalDialog.DELETE ->
            AlertDialog(
                onDismissRequest = onDismiss,
                modifier = Modifier.testTag("delete-dialog"),
                title = { Text("Delete terminal “${terminal.title}”?") },
                text = { Text("The record, its transcript and its recorded screen are removed.") },
                confirmButton = {
                    TextButton(
                        onClick = {
                            onDismiss()
                            actions.onDelete()
                        },
                        colors = ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error),
                        modifier = Modifier.testTag("confirm"),
                    ) { Text("Delete") }
                },
                dismissButton = { TextButton(onClick = onDismiss, modifier = Modifier.testTag("dismiss")) { Text("Cancel") } },
            )
        TerminalDialog.SEND_TEXT -> SendTextDialog(onDismiss, actions.onSendText)
        TerminalDialog.RENAME -> RenameDialog(terminal.title, onDismiss, actions.onRename)
    }
}

/** iOS "Send text": the REST fallback (`POST /input`), for when the stream is disconnected. */
@Composable
private fun SendTextDialog(
    onDismiss: () -> Unit,
    onSend: (String) -> Unit,
) {
    var text by rememberSaveable { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("send-text-dialog"),
        title = { Text("Send text") },
        text = {
            Column(verticalArrangement = Arrangement.spacedBy(8.dp)) {
                Text("REST fallback (POST /input) — useful when the stream is disconnected.", style = OptioTheme.type.footnote)
                OutlinedTextField(
                    value = text,
                    onValueChange = { text = it },
                    placeholder = { Text("Text to write to stdin") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("send-text-field"),
                )
            }
        },
        confirmButton = {
            Row {
                TextButton(onClick = {
                    onDismiss()
                    onSend(text)
                }, enabled = text.isNotEmpty()) { Text("Send") }
                TextButton(onClick = {
                    onDismiss()
                    onSend(text + "\r")
                }, enabled = text.isNotEmpty(), modifier = Modifier.testTag("send-enter")) { Text("Send + Enter") }
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

/** Rename in place (web `title-editor.tsx`, `PATCH /api/local/terminals/:id`). */
@Composable
private fun RenameDialog(
    current: String,
    onDismiss: () -> Unit,
    onRename: (String) -> Unit,
) {
    var title by rememberSaveable { mutableStateOf(current) }
    val save = {
        onDismiss()
        onRename(title)
    }
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = Modifier.testTag("rename-dialog"),
        title = { Text("Rename terminal") },
        text = {
            OutlinedTextField(
                value = title,
                onValueChange = { title = it.take(200) },
                singleLine = true,
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Done),
                keyboardActions = androidx.compose.foundation.text.KeyboardActions(onDone = { if (title.isNotBlank()) save() }),
                modifier = Modifier.fillMaxWidth().testTag("rename-field"),
            )
        },
        confirmButton = { TextButton(onClick = save, enabled = title.isNotBlank()) { Text("Save") } },
        dismissButton = { TextButton(onClick = onDismiss) { Text("Cancel") } },
    )
}

// endregion
