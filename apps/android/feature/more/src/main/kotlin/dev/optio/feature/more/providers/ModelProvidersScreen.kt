package dev.optio.feature.more.providers

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material3.Checkbox
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.model.ModelProvider
import dev.optio.core.model.ModelProviderPodCredential
import dev.optio.core.model.ResourceOwner
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.ownerLabel
import dev.optio.core.network.podCredentialLabel
import dev.optio.core.network.providerAgentLabel
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ChipPicker
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.readableWidth
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.scope.OwnerChoice
import dev.optio.core.ui.scope.OwnerPicker
import dev.optio.core.ui.scope.OwnerScope
import dev.optio.core.ui.scope.Scope
import dev.optio.core.ui.scope.ScopeViewer
import dev.optio.core.ui.scope.privateHint
import dev.optio.core.ui.scope.scopeSections
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `ModelProvidersRoute`: Settings › Model providers (contract "Settings → Model providers"). */
@Composable
fun ModelProvidersScreen() {
    val api = LocalApiClient.current
    val viewModel = viewModel { ModelProvidersViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val saving by viewModel.saving.collectAsStateWithLifecycle()
    val isAdmin = Roles.isAdmin
    val canMutate = Roles.canMutate
    var editing by remember { mutableStateOf<ModelProviderDraft?>(null) }
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel) { viewModel.load() }

    MoreScaffold(
        "Model providers",
        actions = {
            if (canMutate) {
                IconButton(onClick = { editing = ModelProviderDraft.new(isAdmin) }, modifier = Modifier.testTag("add-provider")) {
                    Icon(Icons.Outlined.Add, contentDescription = "Add model provider")
                }
            }
        },
    ) { padding ->
        ModelProvidersContent(
            state = state,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onEdit = { editing = ModelProviderDraft.from(it) },
            onDelete = viewModel::delete,
        )
    }
    editing?.let { draft ->
        ModelProviderEditorSheet(
            draft = draft,
            allowOrganization = isAdmin,
            saving = saving,
            onChange = { editing = it },
            onDismiss = { editing = null },
            onSave = { viewModel.save(draft) { editing = null } },
        )
    }
}

/**
 * The list, stateless, sectioned by scope: Organization / Private / Other people's (an admin's
 * list carries other members' private providers by name; they open read-only, `canEdit` false).
 */
@Composable
fun ModelProvidersContent(
    state: LoadState<List<ModelProvider>>,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onEdit: (ModelProvider) -> Unit,
    onDelete: (ModelProvider) -> Unit,
    modifier: Modifier = Modifier,
    viewer: ScopeViewer = Scope.viewer,
) {
    val confirm = rememberConfirmState()
    Loadable(state = state, onRetry = onRetry, what = "model providers", contentPadding = contentPadding, modifier = modifier) { providers ->
        LazyColumn(Modifier.fillMaxSize().readableWidth().testTag("model-providers"), contentPadding = contentPadding) {
            if (providers.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        title = "No model providers",
                        icon = Icons.Outlined.Cloud,
                        message = "A model provider is a saved way for an agent to reach its models — today Amazon Bedrock, for Claude Code and Codex.",
                    )
                }
            } else {
                scopeSections(providers, viewer) { it.ownerUserId }.forEach { section ->
                    groupedItem("providers-${section.scope.name.lowercase()}", header = section.scope.label, footer = sectionFooter(section.scope)) {
                        if (section.rows.isEmpty()) {
                            Text(
                                if (section.scope == OwnerScope.PRIVATE) privateHint("model providers") else "Nothing shared with the organization yet.",
                                style = OptioTheme.type.footnote,
                                color = OptioTheme.colors.secondaryLabel,
                                modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
                            )
                        }
                        section.rows.forEachIndexed { index, p ->
                            if (index > 0) InsetDivider()
                            ProviderItem(
                                provider = p,
                                onClick = { onEdit(p) },
                                onDelete = {
                                    confirm.ask(title = "Delete ${p.name}?", message = "Work that picks it can't run until it picks another provider.", confirmLabel = "Delete", destructive = true) {
                                        onDelete(p)
                                    }
                                },
                            )
                        }
                    }
                }
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

private fun sectionFooter(scope: OwnerScope): String? = when (scope) {
    OwnerScope.ORGANIZATION -> "Credentials are encrypted on the server and never shown again. Work picks a provider in its agent parameters."
    OwnerScope.PRIVATE -> "Only your own work can pick a private provider; picking one makes the work private."
    OwnerScope.OTHERS -> "Read-only: these run with their owners' credentials."
}

/** "Bedrock · Organization · Claude Code, Codex · us-west-2 · Pods: access key" ("Private" / "Private · Name" for someone's). */
internal fun providerSummary(p: ModelProvider): String = listOf(
    "Bedrock",
    p.ownerLabel,
    p.agents.joinToString(", ") { providerAgentLabel(it) },
    p.region,
    "Pods: ${podCredentialLabel(p.podCredential)}${if (p.hasPodCredentials) " (stored)" else ""}",
).joinToString(" · ")

@Composable
private fun ProviderItem(provider: ModelProvider, onClick: () -> Unit, onDelete: () -> Unit) {
    val colors = OptioTheme.colors
    Row(
        Modifier
            .fillMaxWidth()
            .clickable(enabled = provider.canEdit, onClick = onClick)
            .padding(start = Spacing.l, end = if (provider.canEdit) Spacing.xs else Spacing.l, top = Spacing.m, bottom = Spacing.m)
            .testTag("provider-${provider.name}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Text(provider.name, style = OptioTheme.type.body, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
            Text(providerSummary(provider), style = OptioTheme.type.caption, color = colors.secondaryLabel)
            provider.localAwsProfile?.let { Text("Machines: AWS profile $it", style = OptioTheme.type.caption, color = colors.secondaryLabel) }
        }
        if (provider.canEdit) {
            IconButton(onClick = onDelete, modifier = Modifier.testTag("delete-provider-${provider.name}")) {
                Icon(Icons.Outlined.Delete, contentDescription = "Delete ${provider.name}", tint = colors.secondaryLabel)
            }
        }
    }
}

/** Create / edit a provider. Credentials are typed into plain `remember` state and dropped with the sheet. */
@Composable
fun ModelProviderEditorSheet(
    draft: ModelProviderDraft,
    allowOrganization: Boolean,
    saving: Boolean,
    onChange: (ModelProviderDraft) -> Unit,
    onDismiss: () -> Unit,
    onSave: () -> Unit,
) {
    MoreSheet(
        title = if (draft.isNew) "New model provider" else "Edit ${draft.name}",
        onDismiss = onDismiss,
        confirmLabel = "Save",
        confirmEnabled = draft.problem() == null,
        busy = saving,
        onConfirm = onSave,
    ) {
        ModelProviderEditor(draft, allowOrganization, onChange)
    }
}

@Composable
private fun ColumnScope.Caption(text: String) {
    Text(
        text,
        style = OptioTheme.type.sectionHeader,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(start = Spacing.l + Spacing.l, top = Spacing.s),
    )
}

@Composable
private fun Field(
    value: String,
    onValue: (String) -> Unit,
    label: String,
    tag: String,
    placeholder: String? = null,
    secret: Boolean = false,
    mono: Boolean = false,
    singleLine: Boolean = true,
) {
    OutlinedTextField(
        value = value,
        onValueChange = onValue,
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it) } },
        singleLine = singleLine,
        minLines = if (singleLine) 1 else 3,
        textStyle = if (mono) OptioTheme.type.monoFootnote else OptioTheme.type.body,
        visualTransformation = if (secret) PasswordVisualTransformation() else androidx.compose.ui.text.input.VisualTransformation.None,
        keyboardOptions = KeyboardOptions(
            capitalization = KeyboardCapitalization.None,
            autoCorrectEnabled = false,
            keyboardType = if (secret) KeyboardType.Password else KeyboardType.Text,
        ),
        modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l).testTag(tag),
    )
}

/** The editor fields, stateless. */
@Composable
fun ModelProviderEditor(draft: ModelProviderDraft, allowOrganization: Boolean, onChange: (ModelProviderDraft) -> Unit) {
    Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Field(draft.name, { onChange(draft.copy(name = it)) }, "Name", "provider-name", placeholder = "Bedrock")
        OwnerPicker(
            value = if (draft.owner == ResourceOwner.WORKSPACE) OwnerChoice.ORGANIZATION else OwnerChoice.PRIVATE,
            onChange = { onChange(draft.copy(owner = if (it == OwnerChoice.ORGANIZATION) ResourceOwner.WORKSPACE else ResourceOwner.ME)) },
            what = "provider",
            // A saved organization provider keeps its owner even when a member opens it (the server decides).
            canOrganization = allowOrganization || draft.owner == ResourceOwner.WORKSPACE,
            organizationHint = "Every member can pick it for the organization's work.",
            privateHint = "Only your own work can pick it, and picking it makes that work private. Admins see that it exists.",
        )
        Caption("Agents")
        PROVIDER_AGENTS.forEach { agent ->
            Row(
                Modifier
                    .fillMaxWidth()
                    .heightIn(min = 48.dp)
                    .clickable { onChange(draft.copy(agents = if (agent in draft.agents) draft.agents - agent else draft.agents + agent)) }
                    .padding(horizontal = Spacing.l)
                    .testTag("provider-agent-${agent.raw}"),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Checkbox(checked = agent in draft.agents, onCheckedChange = null)
                Text(providerAgentLabel(agent), style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.padding(start = Spacing.s))
            }
        }
        Field(draft.region, { onChange(draft.withRegion(it)) }, "Region", "provider-region", placeholder = ModelProviderDraft.DEFAULT_REGION, mono = true)
        PROVIDER_AGENTS.filter { it in draft.agents }.forEach { agent ->
            Field(
                draft.models[agent].orEmpty(),
                { onChange(draft.copy(models = draft.models + (agent to it))) },
                "${providerAgentLabel(agent)} models (one per line, id | label; first = default)",
                "provider-models-${agent.raw}",
                mono = true,
                singleLine = false,
            )
        }
        Caption("On your machines")
        Field(draft.localAwsProfile, { onChange(draft.copy(localAwsProfile = it)) }, "AWS profile", "provider-profile", placeholder = "Blank = default credentials", mono = true)
        Caption("In pods")
        ChipPicker(
            options = POD_CREDENTIAL_CHOICES,
            selection = draft.podCredential,
            onSelect = { onChange(draft.copy(podCredential = it)) },
        )
        CredentialFields(draft, onChange)
        draft.problem()?.let {
            Text(it, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(horizontal = Spacing.l))
        }
    }
}

@Composable
private fun CredentialFields(draft: ModelProviderDraft, onChange: (ModelProviderDraft) -> Unit) {
    val note = when (draft.podCredential) {
        ModelProviderPodCredential.AMBIENT -> "Pods use their own AWS identity (IRSA / instance profile)."
        ModelProviderPodCredential.NONE -> "Work in a pod can't use this provider; only your machines can."
        else -> null
    }
    if (note != null) {
        Text(note, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(horizontal = Spacing.l))
        if (draft.hasStored) {
            Text("Stored credentials will be cleared.", style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(horizontal = Spacing.l))
        }
        return
    }
    if (draft.hasStored) {
        ChipPicker(
            options = listOf(CredentialMode.KEEP to "Stored", CredentialMode.REPLACE to "Replace", CredentialMode.CLEAR to "Clear"),
            selection = draft.credentialMode,
            onSelect = { onChange(draft.copy(credentialMode = it)) },
        )
    }
    if (draft.credentialMode != CredentialMode.REPLACE) return
    if (draft.podCredential == ModelProviderPodCredential.ACCESS_KEY) {
        Field(draft.accessKeyId, { onChange(draft.copy(accessKeyId = it)) }, "Access key id", "provider-access-key-id", mono = true)
        Field(draft.secretAccessKey, { onChange(draft.copy(secretAccessKey = it)) }, "Secret access key", "provider-secret-key", secret = true)
        Field(draft.sessionToken, { onChange(draft.copy(sessionToken = it)) }, "Session token (optional)", "provider-session-token", secret = true)
    } else {
        Field(draft.bearerToken, { onChange(draft.copy(bearerToken = it)) }, "Bedrock API key", "provider-bearer", secret = true)
    }
}
