package dev.optio.feature.more.secrets

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
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Folder
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material.icons.outlined.Public
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
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
import dev.optio.core.ui.scope.OwnerChoice
import dev.optio.core.ui.scope.OwnerPicker
import dev.optio.core.ui.scope.OwnerScope
import dev.optio.core.ui.scope.Scope
import dev.optio.core.ui.scope.ScopeViewer
import dev.optio.core.ui.scope.privateHint
import dev.optio.core.ui.scope.scopeSections
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
    val viewer = Scope.viewer
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
            // Someone else's private secret (an admin, offboarding) is deleted by naming its owner.
            onDelete = { secret -> viewModel.delete(secret, ownerUserId = secret.owner.takeIf { viewer.isOthers(it) }) },
            viewerId = viewer.id,
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

/**
 * The filter chips and the list, stateless. On **All** the rows are sectioned by scope —
 * Organization / Private / Other people's (admins) — so every scope is visible at a glance; a
 * filter shows its rows flat. [viewerId] tells your private secrets from other people's (null =
 * unknown, or an auth-disabled server: every private row is yours).
 */
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
    viewerId: String? = null,
) {
    val viewer = ScopeViewer(viewerId, isAdmin)
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
            val askDelete: (SecretRow) -> Unit = { secret ->
                confirm.ask(title = "Delete secret ${secret.name}?", confirmLabel = "Delete", destructive = true) { onDelete(secret) }
            }
            when {
                data.secrets.isEmpty() -> item(key = "empty") {
                    EmptyState(
                        title = "No secrets",
                        icon = Icons.Outlined.Key,
                        message = "Add API keys for Claude Code, Codex, or GitHub to get started.",
                    )
                }
                filter == SecretsViewModel.FILTER_ALL -> {
                    scopeSections(data.secrets, viewer) { it.owner }.forEach { section ->
                        groupedItem("secrets-${section.scope.name.lowercase()}", header = section.scope.label, footer = sectionFooter(section.scope)) {
                            if (section.rows.isEmpty()) {
                                SectionNote(
                                    if (section.scope == OwnerScope.PRIVATE) privateHint("secrets") else "Nothing shared with the organization yet.",
                                )
                            }
                            section.rows.forEachIndexed { index, secret ->
                                if (index > 0) InsetDivider()
                                SecretItem(secret, data, viewer, now, onDelete = { askDelete(secret) })
                            }
                        }
                    }
                }
                else -> groupedItem("secrets", footer = "Values are encrypted at rest and never returned by the API.") {
                    data.secrets.forEachIndexed { index, secret ->
                        if (index > 0) InsetDivider()
                        SecretItem(secret, data, viewer, now, onDelete = { askDelete(secret) })
                    }
                }
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** What each section's footer says. */
private fun sectionFooter(scope: OwnerScope): String? = when (scope) {
    OwnerScope.ORGANIZATION -> "Values are encrypted at rest and never returned by the API."
    OwnerScope.PRIVATE ->
        "Only your own work gets a private secret. Background runs of the organization's work (schedules, webhooks, ticket sync) don't."
    OwnerScope.OTHERS -> "Read-only: these run with their owners' credentials. Delete one to offboard its owner."
}

@Composable
private fun SectionNote(text: String) {
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
    )
}

/** All, Organization, Private, then one per repo (iOS scope `Picker`). */
internal fun scopeFilters(repos: List<RepoRef>): List<Pair<String, String>> =
    listOf(
        SecretsViewModel.FILTER_ALL to "All",
        SecretsViewModel.FILTER_ORGANIZATION to OwnerScope.ORGANIZATION.label,
        SecretRow.SCOPE_USER to OwnerScope.PRIVATE.label,
    ) + repos.mapNotNull { repo -> repo.repoUrl?.let { it to repo.displayName } }

/**
 * Who may delete [secret]: its owner for a private one, an admin for anything (including other
 * people's private secrets, for offboarding).
 */
internal fun canDeleteSecret(
    secret: SecretRow,
    viewer: ScopeViewer,
): Boolean = viewer.isAdmin || (secret.isPrivate && !viewer.isOthers(secret.owner))

@Composable
private fun SecretItem(
    secret: SecretRow,
    data: SecretsData,
    viewer: ScopeViewer,
    now: java.time.Instant,
    onDelete: () -> Unit,
) {
    // "All repos" / the repo for the organization's; "Private" / "Private · Name" for someone's.
    val scopeLabel = viewer.privateTag(secret.owner, secret.ownerName) ?: data.scopeLabel(secret.scope)
    SecretItem(
        secret = secret,
        scopeLabel = scopeLabel,
        updated = (secret.updatedAt ?: secret.createdAt)?.relativeDescription(now),
        canDelete = canDeleteSecret(secret, viewer),
        onDelete = onDelete,
    )
}

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

/** iOS `scopeIcon`: globe (all repos), lock (private), folder (one repo). */
internal fun scopeIcon(scope: String?): ImageVector = when (scope) {
    null, SecretRow.SCOPE_GLOBAL -> Icons.Outlined.Public
    SecretRow.SCOPE_USER -> Icons.Outlined.Lock
    else -> Icons.Outlined.Folder
}

/**
 * Create or replace a secret by name (iOS `SecretFormSheet`). The value is a password field held
 * only in plain `remember` (never saved into instance state) and dropped with the sheet. It opens
 * on Organization for admins and Private for everyone else.
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
            repos = repos,
            allowGlobal = allowGlobal,
        )
    }
}

/** The owner the form shows for a scope key: `user` is Private, everything else the organization's. */
internal fun ownerChoiceOf(scope: String): OwnerChoice = if (scope == SecretRow.SCOPE_USER) OwnerChoice.PRIVATE else OwnerChoice.ORGANIZATION

/** Where an organization secret applies: every repo, or one. */
internal fun repoScopes(repos: List<RepoRef>): List<Pair<String, String>> =
    listOf(SecretRow.SCOPE_GLOBAL to "All repos") + repos.mapNotNull { repo -> repo.repoUrl?.let { it to repo.displayName } }

/**
 * The form fields, stateless: name, value, the Owner row (Organization / Private — Organization
 * needs an admin, [allowGlobal]) and, for the organization's, where it applies (all repos or one).
 * [scope] is what the API takes: `global`, `user`, or a repo URL.
 */
@Composable
fun SecretForm(
    name: String,
    onName: (String) -> Unit,
    value: String,
    onValue: (String) -> Unit,
    scope: String,
    onScope: (String) -> Unit,
    repos: List<RepoRef>,
    allowGlobal: Boolean,
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
        OwnerPicker(
            value = ownerChoiceOf(scope),
            onChange = { choice -> onScope(if (choice == OwnerChoice.PRIVATE) SecretRow.SCOPE_USER else SecretRow.SCOPE_GLOBAL) },
            what = "secret",
            canOrganization = allowGlobal,
            organizationHint = "Every pod the workspace runs gets it — all repos, or one.",
            privateHint = "Only your own work gets it. Background runs of the organization's work (schedules, webhooks, ticket sync) don't.",
        )
        if (ownerChoiceOf(scope) == OwnerChoice.ORGANIZATION && repos.isNotEmpty()) {
            Text(
                "Applies to",
                style = OptioTheme.type.sectionHeader,
                color = OptioTheme.colors.secondaryLabel,
                modifier = Modifier.padding(start = Spacing.l + Spacing.l),
            )
            ChipPicker(
                options = repoScopes(repos),
                selection = scope,
                onSelect = onScope,
                modifier = Modifier.testTag("secret-repo-scope"),
                tagPrefix = "secret-scope",
            )
        }
        Text(
            "Saving an existing name replaces its value. Auth tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN) are validated after saving.",
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.l),
        )
    }
}
