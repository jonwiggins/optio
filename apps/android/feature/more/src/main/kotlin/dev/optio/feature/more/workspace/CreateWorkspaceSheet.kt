package dev.optio.feature.more.workspace

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import dev.optio.core.network.ApiError
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.more.api.WorkspaceRow
import dev.optio.feature.more.api.createWorkspace
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.ui.moreErrorText
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

/**
 * New workspace (iOS `CreateWorkspaceSheet`): name, a slug that follows the name until edited, an
 * optional description. The creator becomes its admin.
 */
@Composable
fun CreateWorkspaceSheet(
    onDismiss: () -> Unit,
    onCreated: (WorkspaceRow) -> Unit,
) {
    val api = LocalApiClient.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    var name by rememberSaveable { mutableStateOf("") }
    var slug by rememberSaveable { mutableStateOf("") }
    var slugEdited by rememberSaveable { mutableStateOf(false) }
    var description by rememberSaveable { mutableStateOf("") }
    var saving by rememberSaveable { mutableStateOf(false) }

    MoreSheet(
        title = "New Workspace",
        onDismiss = onDismiss,
        confirmLabel = "Create",
        confirmEnabled = name.isNotBlank() && slug.isNotEmpty(),
        busy = saving,
        onConfirm = {
            saving = true
            scope.launch {
                try {
                    onCreated(api.createWorkspace(name.trim(), slug, description.ifBlank { null }))
                } catch (e: CancellationException) {
                    throw e
                } catch (e: ApiError) {
                    toaster.error(moreErrorText(e))
                } finally {
                    saving = false
                }
            }
        },
    ) {
        CreateWorkspaceForm(
            name = name,
            slug = slug,
            description = description,
            onName = {
                name = it
                if (!slugEdited) slug = slugify(it)
            },
            onSlug = {
                slug = it
                if (it != slugify(name)) slugEdited = true
            },
            onDescription = { description = it },
        )
    }
}

/** The form fields, stateless. */
@Composable
fun CreateWorkspaceForm(
    name: String,
    slug: String,
    description: String,
    onName: (String) -> Unit,
    onSlug: (String) -> Unit,
    onDescription: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            label = { Text("Name") },
            singleLine = true,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Words, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag("workspace-name"),
        )
        OutlinedTextField(
            value = slug,
            onValueChange = onSlug,
            label = { Text("Slug") },
            singleLine = true,
            textStyle = OptioTheme.type.monoBody,
            keyboardOptions = KeyboardOptions(autoCorrectEnabled = false, keyboardType = KeyboardType.Uri, imeAction = ImeAction.Next),
            modifier = Modifier.fillMaxWidth().testTag("workspace-slug"),
        )
        OutlinedTextField(
            value = description,
            onValueChange = onDescription,
            label = { Text("Description (optional)") },
            minLines = 2,
            modifier = Modifier.fillMaxWidth().testTag("workspace-description"),
        )
        Text(
            "You become the admin of the new workspace.",
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.xs),
        )
    }
}

/**
 * A workspace slug from a name (iOS `CreateWorkspaceSheet.slugify`): lowercase ASCII letters and
 * digits, every other run of characters becomes one hyphen, no leading or trailing hyphens.
 */
fun slugify(text: String): String {
    val out = StringBuilder()
    var lastDash = true
    for (ch in text.lowercase()) {
        if (ch.code < 128 && ch.isLetterOrDigit()) {
            out.append(ch)
            lastDash = false
        } else if (!lastDash) {
            out.append('-')
            lastDash = true
        }
    }
    while (out.endsWith("-")) out.setLength(out.length - 1)
    return out.toString()
}
