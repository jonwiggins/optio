package dev.optio.core.ui.components

import androidx.compose.material3.AlertDialog
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag

/**
 * A confirmation before an action that can't be undone or costs something (iOS
 * `confirmationDialog` / destructive `alert`): a title, an optional [message], the confirm verb
 * and Cancel. [destructive] paints the confirm button red. Verbs: "Save" for edits, "Create" for
 * new things, the action's own verb otherwise ("Kill", "Delete", "Merge anyway"). Test tags:
 * `confirm-dialog`, `confirm`, `dismiss`.
 */
@Composable
fun ConfirmDialog(
    title: String,
    onConfirm: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
    message: String? = null,
    confirmLabel: String = "Confirm",
    dismissLabel: String = "Cancel",
    destructive: Boolean = false,
    icon: ImageVector? = null,
) {
    AlertDialog(
        onDismissRequest = onDismiss,
        modifier = modifier.testTag("confirm-dialog"),
        icon = icon?.let { { Icon(it, contentDescription = null) } },
        title = { Text(title) },
        text = message?.let { { Text(it) } },
        confirmButton = {
            TextButton(
                onClick = {
                    onDismiss()
                    onConfirm()
                },
                colors = if (destructive) {
                    ButtonDefaults.textButtonColors(contentColor = MaterialTheme.colorScheme.error)
                } else {
                    ButtonDefaults.textButtonColors()
                },
                modifier = Modifier.testTag("confirm"),
            ) { Text(confirmLabel) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss, modifier = Modifier.testTag("dismiss")) { Text(dismissLabel) }
        },
    )
}

/** One pending confirmation ([ConfirmState.ask]). */
@Immutable
class ConfirmRequest(
    val title: String,
    val message: String?,
    val confirmLabel: String,
    val destructive: Boolean,
    val icon: ImageVector?,
    val onConfirm: () -> Unit,
)

/**
 * Ask-then-act without a boolean per action: call [ask] from a menu item or button, place
 * [ConfirmHost] once on the screen.
 *
 * ```
 * val confirm = rememberConfirmState()
 * DropdownMenuItem(text = { Text("Kill") }, onClick = {
 *     confirm.ask("Kill this terminal?", "The process is stopped.", "Kill", destructive = true) { vm.kill() }
 * })
 * ConfirmHost(confirm)
 * ```
 */
@Stable
class ConfirmState {
    var pending: ConfirmRequest? by mutableStateOf(null)
        private set

    fun ask(
        title: String,
        message: String? = null,
        confirmLabel: String = "Confirm",
        destructive: Boolean = false,
        icon: ImageVector? = null,
        onConfirm: () -> Unit,
    ) {
        pending = ConfirmRequest(title, message, confirmLabel, destructive, icon, onConfirm)
    }

    fun dismiss() {
        pending = null
    }
}

@Composable
fun rememberConfirmState(): ConfirmState = remember { ConfirmState() }

/** Shows [state]'s pending confirmation, if any. */
@Composable
fun ConfirmHost(state: ConfirmState) {
    val request = state.pending ?: return
    ConfirmDialog(
        title = request.title,
        message = request.message,
        confirmLabel = request.confirmLabel,
        destructive = request.destructive,
        icon = request.icon,
        onConfirm = request.onConfirm,
        onDismiss = state::dismiss,
    )
}
