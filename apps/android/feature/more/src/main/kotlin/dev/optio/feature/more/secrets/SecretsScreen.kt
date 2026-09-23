package dev.optio.feature.more.secrets

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Person
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.state.isForbidden
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.api.RepoRef
import dev.optio.feature.more.api.SecretRow
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MembersOnlyState
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `SecretsRoute` (iOS `SecretsView`). */
@Composable
fun SecretsScreen() {
    val api = LocalApiClient.current
    val viewModel = viewModel { SecretsViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val filter by viewModel.scopeFilter.collectAsStateWithLifecycle()
    val saving by viewModel.saving.collectAsStateWithLifecycle()
    val isAdmin = Roles.isAdmin
    val canMutate = Roles.canMutate
    var showForm by rememberSaveable { mutableStateOf(false) }
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel) { viewModel.load() }

    MoreScaffold(
        "Secrets",
        actions = {
            if (canMutate) {
                IconButton(onClick = { showForm = true }, modifier = Modifier.testTag("add-secret")) {
                    Icon(Icons.Outlined.Add, contentDescription = "Add secret")
                }
            }
        },
    ) { padding ->
        SecretsContent(
            state = state,
            filter = filter,
            isAdmin = isAdmin,
            contentPadding = padding,
            onFilter = viewModel::setFilter,
            onRetry = viewModel::refresh,
            onDelete = viewModel::delete,
        )
    }
    if (showForm) {
        SecretFormSheet(
            repos = state.value?.repos.orEmpty(),
            allowGlobal = isAdmin,
            saving = saving,
            onDismiss = { showForm = false },
            onSave = { name, value, scope -> viewModel.save(name, value, scope) { showForm = false } },
        )
    }
}

/** The filter chips and the list, stateless. */
@Composable
fun SecretsContent(
    state: LoadState<SecretsData>,
    filter: String,
    isAdmin: Boolean,
    contentPadding: PaddingValues,
    onFilter: (String) -> Unit,
    onRetry: () -> Unit,
    onDelete: (SecretRow) -> Unit,
    modifier: Modifier = Modifier,
) {
    val confirm = rememberConfirmState()
    val error = state.errorOrNull
    if (error != null && state.value == null && error.isForbidden) {
        Box(modifier.fillMaxSize().padding(contentPadding)) { MembersOnlyState("Secrets") }
        return
    }
    Loadable(state = state, onRetry = onRetry, what = "secrets", contentPadding = contentPadding, modifier = modifier) { data ->
        val now = rememberNow()
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("secrets"), contentPadding = contentPadding) {
            item(key = "filter") {
                ChipPicker(
                    options = scopeFilters(data.repos),
                    selection = filter,
                    onSelect = onFilter,
                )
            }
            if (data.secrets.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        title = "No secrets",
                        icon = Icons.Outlined.Key,
                        message = "Add API keys for Claude Code, Codex, or GitHub to get started.",
                    )
                }
            } else {
                groupedItem(
                    "secrets",
                    footer = if (data.secrets.any { it.scope == SecretRow.SCOPE_USER }) {
                        "User-only secrets are scoped to you and are not visible to background runs (ticket sync, schedules, " +
                            "webhooks). Store a credential as Global to make it available everywhere."
                    } else {
                        "Values are encrypted at rest and never returned by the API."
                    },
                ) {
                    data.secrets.forEachIndexed { index, secret ->
                        if (index > 0) InsetDivider()
                        SecretItem(
                            secret = secret,
                            scopeLabel = data.scopeLabel(secret.scope),
                            updated = (secret.updatedAt ?: secret.createdAt)?.relativeDescription(now),
                            canDelete = isAdmin || secret.scope == SecretRow.SCOPE_USER,
                            onDelete = {
                                confirm.ask(title = "Delete secret ${secret.name}?", confirmLabel = "Delete", destructive = true) {
                                    onDelete(secret)
                                }
                            },
                        )
                    }
                }
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** All scopes, Global only, User-only, then one per repo (iOS scope `Picker`). */
internal fun scopeFilters(repos: List<RepoRef>): List<Pair<String, String>> =
    listOf(
        SecretsViewModel.FILTER_ALL to "All scopes",
        SecretRow.SCOPE_GLOBAL to "Global only",
        SecretRow.SCOPE_USER to "User-only",
    ) + repos.mapNotNull { repo -> repo.repoUrl?.let { it to repo.displayName } }

@Composable
private fun SecretItem(
    secret: SecretRow,
    scopeLabel: String,
    updated: String?,
    canDelete: Boolean,
    onDelete: () -> Unit,
) {
    val colors = OptioTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .padding(start = Spacing.l, end = if (canDelete) Spacing.xs else Spacing.l, top = Spacing.m, bottom = Spacing.m)
            .testTag("secret-${secret.name}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(secret.name, style = OptioTheme.type.monoBody, color = colors.label, maxLines = 1, overflow = TextOverflow.MiddleEllipsis)
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
                Icon(scopeIcon(secret.scope), contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(14.dp))
                Text(
                    listOfNotNull(scopeLabel, updated?.let { "Updated $it" }).joinToString(" · "),
                    style = OptioTheme.type.caption,
                    color = colors.secondaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (canDelete) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("delete-${secret.name}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete ${secret.name}", tint = colors.secondaryLabel)
            }
        }
    }
}

/** iOS `scopeIcon`: globe, person, folder. */
internal fun scopeIcon(scope: String?): ImageVector = when (scope) {
    null, SecretRow.SCOPE_GLOBAL -> Icons.Outlined.Public
    SecretRow.SCOPE_USER -> Icons.Outlined.Person
    else -> Icons.Outlined.Folder
}

/**
 * Create or replace a secret by name (iOS `SecretFormSheet`). The value is a password field held
 * only in plain `remember` (never saved into instance state) and dropped with the sheet.
 */
@Composable
fun SecretFormSheet(
    repos: List<RepoRef>,
    allowGlobal: Boolean,
    saving: Boolean,
    onDismiss: () -> Unit,
    onSave: (name: String, value: String, scope: String) -> Unit,
) {
    var name by rememberSaveable { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var scope by rememberSaveable { mutableStateOf(if (allowGlobal) SecretRow.SCOPE_GLOBAL else SecretRow.SCOPE_USER) }
    MoreSheet(
        title = "Add Secret",
        onDismiss = onDismiss,
        confirmLabel = "Save",
        confirmEnabled = name.isNotBlank() && value.isNotEmpty(),
        busy = saving,
        onConfirm = { onSave(name, value, scope) },
    ) {
        SecretForm(
            name = name,
            onName = { name = it },
            value = value,
            onValue = { value = it },
            scope = scope,
            onScope = { scope = it },
            scopes = secretScopes(repos, allowGlobal),
        )
    }
}

/** The scopes a secret may be saved in: members may only store their own (user) secrets. */
internal fun secretScopes(
    repos: List<RepoRef>,
    allowGlobal: Boolean,
): List<Pair<String, String>> {
    if (!allowGlobal) return listOf(SecretRow.SCOPE_USER to "User-only (just me)")
    return listOf(SecretRow.SCOPE_GLOBAL to "Global (all repos)", SecretRow.SCOPE_USER to "User-only (just me)") +
        repos.mapNotNull { repo -> repo.repoUrl?.let { it to repo.displayName } }
}

/** The form fields, stateless. */
@Composable
fun SecretForm(
    name: String,
    onName: (String) -> Unit,
    value: String,
    onValue: (String) -> Unit,
    scope: String,
    onScope: (String) -> Unit,
    scopes: List<Pair<String, String>>,
    modifier: Modifier = Modifier,
) {
    Column(modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            label = { Text("Name") },
            placeholder = { Text("ANTHROPIC_API_KEY") },
            singleLine = true,
            textStyle = OptioTheme.type.monoBody,
            keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l).testTag("secret-name"),
        )
        OutlinedTextField(
            value = value,
            onValueChange = onValue,
            label = { Text("Value") },
            singleLine = true,
            visualTransformation = PasswordVisualTransformation(),
            keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l).testTag("secret-value"),
        )
        Text(
            "Scope",
            style = OptioTheme.type.sectionHeader,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(start = Spacing.l + Spacing.l, top = Spacing.s),
        )
        Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l)) {
            scopes.forEach { (key, label) ->
                Row(
                    Modifier
                        .fillMaxWidth()
                        .heightIn(min = 48.dp)
                        .selectable(selected = key == scope, role = Role.RadioButton, onClick = { onScope(key) })
                        .testTag("scope-$key"),
                    verticalAlignment = Alignment.CenterVertically,
                ) {
                    RadioButton(selected = key == scope, onClick = null)
                    Icon(scopeIcon(key), contentDescription = null, tint = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(start = Spacing.s).size(18.dp))
                    Text(label, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.padding(start = Spacing.s))
                }
            }
        }
        Text(
            "Saving an existing name replaces its value. Auth tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN) are validated after saving.",
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.l),
        )
    }
}
