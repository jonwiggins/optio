package dev.optio.feature.workform

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Close
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Key
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.InputChip
import androidx.compose.material3.InputChipDefaults
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.foundation.layout.Row
import androidx.compose.material.icons.outlined.Cloud
import androidx.compose.material3.OutlinedButton
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.text.input.VisualTransformation
import dev.optio.core.model.AgentCredentialInput
import dev.optio.core.model.AgentCredentialKind
import dev.optio.core.model.AgentCredentialMethodOption
import dev.optio.core.model.PickableSecret
import dev.optio.core.model.VerifyAgentCredentialResult
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.ModelProvidersRoute
import dev.optio.core.network.isOrganization
import dev.optio.core.ui.agent.runtimeLabel
import kotlinx.coroutines.launch
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.form.CardNote
import dev.optio.core.ui.form.MenuRow
import dev.optio.core.ui.form.MenuChoice
import dev.optio.core.ui.form.MenuCaption
import dev.optio.core.ui.form.MenuDivider
import dev.optio.core.ui.form.RowDivider

// The Who card's provider / owner / secrets rows (contract "Work form"): the Provider control
// (hidden when no provider serves the runtime, so the form looks as before), "Owner" for pod
// work (Organization / Private), and the secrets the agent's pod gets.

/** Up to this many providers the control is a segmented row; more become a menu. */
private const val SEGMENTED_MAX = 2

/** The Provider control: Default + each usable provider. Nothing when none serves the runtime. */
@Composable
internal fun ProviderRows(state: WorkFormState) {
    val providers = state.usableProviders
    if (providers.isEmpty()) return
    val pickedId = pickedProviderId(state.draft).orEmpty()
    val picked = providers.firstOrNull { it.id == pickedId }
    if (providers.size <= SEGMENTED_MAX) {
        SegmentedRow(
            options = listOf("" to "Default") + providers.map { it.id to it.name },
            selection = pickedId,
            onSelect = { id -> state.setProvider(providers.firstOrNull { it.id == id }) },
            disabled = { id -> providers.firstOrNull { it.id == id }?.let(state::providerDisabled) },
            modifier = Modifier.testTag("work-form-provider"),
        )
        providers.filter { it.id != pickedId }.mapNotNull { p -> state.providerDisabled(p)?.let { "${p.name}: $it" } }
            .takeIf { it.isNotEmpty() }?.let { CardNote(it.joinToString(" · ")) }
    } else {
        MenuRow(label = "Provider", value = picked?.name ?: "Default", modifier = Modifier.testTag("work-form-provider")) {
            MenuChoice("Default", selected = picked == null, subtitle = "The agent's own sign-in", onClick = { state.setProvider(null) })
            providers.forEach { p ->
                val reason = state.providerDisabled(p)
                MenuChoice(
                    p.name,
                    selected = p.id == pickedId,
                    subtitle = reason ?: if (p.isOrganization) "Organization · ${p.region}" else "Private · ${p.region}",
                    enabled = reason == null || p.id == pickedId,
                    onClick = { state.setProvider(p) },
                )
            }
        }
    }
    // A saved pick that is now unusable (deleted, machines only, missing profile) says so.
    if (picked != null) state.providerDisabled(picked)?.let { CardNote("${picked.name}: $it") }
    state.ownerNote?.let { CardNote(it) }
    RowDivider()
}

/** The private work's helper sentence (web `PRIVATE_WORK_HINT`). */
internal const val PRIVATE_WORK_HINT = "Runs with your own secrets, model providers and connections. Only you see it; admins see that it exists."

/** The organization's (web `ORG_WORK_HINT`). */
internal const val ORG_WORK_HINT = "Uses the organization's secrets, providers and connections. Everyone in the workspace sees it."

/** "Owner": Organization / Private (pod work only). */
@Composable
internal fun OwnerRows(state: WorkFormState) {
    if (!state.showsOwner) return
    RowDivider()
    Text(
        "Owner",
        style = OptioTheme.type.footnote,
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(start = Spacing.l, top = Spacing.s),
    )
    SegmentedRow(
        options = WorkOwner.entries.map { it to it.label },
        selection = state.draft.owner,
        onSelect = state::setOwner,
        disabled = { if (it == WorkOwner.WORKSPACE) state.organizationDisabled else null },
        modifier = Modifier.testTag("work-form-owner"),
    )
    if (state.draft.owner == WorkOwner.WORKSPACE) {
        CardNote(state.organizationDisabled ?: ORG_WORK_HINT)
    } else {
        CardNote(PRIVATE_WORK_HINT)
    }
}

/** The secrets the agent's pod gets: chips, "+ Add secret", "New secret…". */
@OptIn(ExperimentalLayoutApi::class)
@Composable
internal fun PodSecretsRows(state: WorkFormState) {
    if (!state.showsPodSecrets) return
    val colors = OptioTheme.colors
    val picked = state.draft.podSecrets
    var creating by remember { mutableStateOf(false) }
    RowDivider()
    val addable = state.addableSecrets
    MenuRow(label = "Secrets", value = "+ Add secret", placeholder = true, modifier = Modifier.testTag("work-form-secrets")) {
        if (addable.isEmpty()) MenuCaption(if (state.pickableSecrets.isEmpty()) "No secrets yet." else "Every secret you can pick is picked.")
        addable.forEach { s ->
            MenuChoice(
                s.name,
                selected = false,
                subtitle = if (s.owner == PickableSecret.Owner.ME) WorkOwner.ME.label else WorkOwner.WORKSPACE.label,
                icon = Icons.Outlined.Key,
                mono = true,
                onClick = { state.addPodSecret(s.name) },
            )
        }
        MenuDivider()
        MenuChoice("New secret…", selected = false, icon = Icons.Outlined.Add, onClick = { creating = true })
    }
    if (!picked.isNullOrEmpty()) {
        FlowRow(
            Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.s),
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            picked.forEach { name ->
                InputChip(
                    selected = false,
                    onClick = { state.removePodSecret(name) },
                    label = { Text("$name · ${state.secretOwnerTag(name)}", style = OptioTheme.type.footnote) },
                    trailingIcon = { Icon(Icons.Filled.Close, contentDescription = "Remove $name", modifier = Modifier.size(InputChipDefaults.IconSize)) },
                    colors = InputChipDefaults.inputChipColors(containerColor = colors.fillTertiary),
                    border = null,
                    modifier = Modifier.testTag("work-form-secret-$name"),
                )
            }
        }
    }
    CardNote(
        if (picked == null) {
            "Saved before secrets were picked: the pod gets the workspace's secrets as before. Pick some to limit it — only what you pick is available to the agent."
        } else {
            "Only what you pick is available to the agent."
        },
    )
    if (creating) {
        NewSecretSheet(
            allowOrganization = state.me?.isAdmin == true && state.draft.owner == WorkOwner.WORKSPACE,
            busy = state.creatingSecret,
            onDismiss = { creating = false },
            onCreate = { name, value, personal, done -> state.createSecretAsync(name, value, personal, done) },
        )
    }
}

/** "New secret…": name, value (write-only) and owner; created, then picked. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun NewSecretSheet(
    allowOrganization: Boolean,
    busy: Boolean,
    onDismiss: () -> Unit,
    onCreate: (name: String, value: String, personal: Boolean, done: (Boolean) -> Unit) -> Unit,
) {
    var name by remember { mutableStateOf("") }
    var value by remember { mutableStateOf("") }
    var owner by remember { mutableStateOf(WorkOwner.ME) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l).padding(bottom = Spacing.l).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text("New secret", style = OptioTheme.type.headline, color = OptioTheme.colors.label)
            OutlinedTextField(
                value = name,
                onValueChange = { name = it },
                label = { Text("Name") },
                placeholder = { Text("API_TOKEN") },
                singleLine = true,
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Characters, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("work-form-new-secret-name"),
            )
            OutlinedTextField(
                value = value,
                onValueChange = { value = it },
                label = { Text("Value") },
                singleLine = true,
                visualTransformation = PasswordVisualTransformation(),
                keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                modifier = Modifier.fillMaxWidth().testTag("work-form-new-secret-value"),
            )
            if (allowOrganization) {
                SegmentedRow(
                    options = WorkOwner.entries.map { it to it.label },
                    selection = owner,
                    onSelect = { owner = it },
                )
            } else {
                Text("Saved as private: only you see it, and only your work can use it.", style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
            }
            Button(
                onClick = { onCreate(name, value, owner == WorkOwner.ME || !allowOrganization) { ok -> if (ok) onDismiss() } },
                enabled = !busy && name.isNotBlank() && value.isNotEmpty(),
                modifier = Modifier.fillMaxWidth().testTag("work-form-new-secret-save"),
            ) { Text(if (busy) "Saving…" else "Create and pick") }
        }
    }
}

// region Signed in with

/**
 * "Signed in with": Default + every credential the work may use — the agent's sign-in secrets and
 * model providers in one list — and "Add credentials…". Pod work with an agent only; a machine
 * keeps the Provider control (its own CLI login signs the agent in there).
 */
@Composable
internal fun SignedInRows(state: WorkFormState) {
    if (state.isLocal) {
        ProviderRows(state)
        return
    }
    if (!state.showsCredentials) return
    val navigator = LocalNavigator.current
    val credentials = state.usableCredentials
    val picked = state.pickedCredential
    val default = credentials.firstOrNull { it.default }
    var adding by remember { mutableStateOf(false) }
    MenuRow(label = "Signed in with", value = credentialValueLabel(picked), modifier = Modifier.testTag("work-form-credential")) {
        MenuChoice(
            "Default",
            selected = picked == null,
            subtitle = default?.let { "${it.label} · ${credentialOwnerLabel(it)}" } ?: "The agent's usual sign-in",
            onClick = { state.setCredential(null) },
        )
        if (credentials.isEmpty()) MenuCaption(if (state.credentialsLoading) "Loading…" else "No credentials yet — add one below.")
        credentials.forEach { c ->
            val reason = state.credentialDisabled(c)
            MenuChoice(
                c.label,
                selected = c.id == picked?.id,
                subtitle = reason ?: credentialSubtitle(c),
                enabled = reason == null || c.id == picked?.id,
                icon = if (c.kind == AgentCredentialKind.PROVIDER) Icons.Outlined.Cloud else Icons.Outlined.Key,
                onClick = { state.setCredential(c) },
            )
        }
        MenuDivider()
        MenuChoice("Add credentials…", selected = false, icon = Icons.Outlined.Add, onClick = { adding = true })
    }
    // A saved pick this viewer can't use any more (removed, someone else's) says so.
    if (pickedCredentialId(state.draft) != null && picked == null && state.credentialOptions != null) {
        CardNote("The saved sign-in isn't available here any more — pick another, or Default.")
    }
    if (picked != null) state.credentialDisabled(picked)?.let { CardNote("${picked.label}: $it") }
    state.ownerNote?.let { CardNote(it) }
    RowDivider()
    if (adding) {
        AddCredentialSheet(
            runtime = state.draft.runtime,
            methods = state.addableCredentialMethods,
            allowOrganization = state.me?.isAdmin == true,
            busy = state.creatingCredential,
            verifying = state.verifyingCredential,
            onDismiss = { adding = false },
            onBedrock = {
                adding = false
                navigator.push(ModelProvidersRoute)
            },
            onVerify = state::verifyCredential,
            onCreate = { name, value, personal, verify, done -> state.createCredentialAsync(name, value, personal, verify, done) },
        )
    }
}

/** "Add credentials…": a method, its value (write-only), the owner; tested when the service allows; saved, then picked. */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AddCredentialSheet(
    runtime: String,
    methods: List<AgentCredentialMethodOption>,
    allowOrganization: Boolean,
    busy: Boolean,
    verifying: Boolean,
    onDismiss: () -> Unit,
    onBedrock: () -> Unit,
    onVerify: suspend (secretName: String, value: String) -> VerifyAgentCredentialResult,
    onCreate: (secretName: String, value: String, personal: Boolean, verify: Boolean, done: (String?) -> Unit) -> Unit,
) {
    val colors = OptioTheme.colors
    val scope = rememberCoroutineScope()
    var method by remember(methods) { mutableStateOf(methods.firstOrNull()) }
    var value by remember { mutableStateOf("") }
    var owner by remember { mutableStateOf(WorkOwner.ME) }
    var checked by remember { mutableStateOf<VerifyAgentCredentialResult?>(null) }
    var failure by remember { mutableStateOf<String?>(null) }
    ModalBottomSheet(onDismissRequest = onDismiss) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l).padding(bottom = Spacing.l).navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text("Add credentials for ${runtimeLabel(runtime)}", style = OptioTheme.type.headline, color = colors.label)
            MenuRow(
                label = "Credential",
                value = method?.label ?: "Amazon Bedrock…",
                modifier = Modifier.testTag("work-form-new-credential-method"),
            ) {
                methods.forEach { m ->
                    MenuChoice(
                        m.label,
                        selected = m.secretName == method?.secretName,
                        subtitle = m.secretName,
                        onClick = {
                            method = m
                            value = ""
                            checked = null
                            failure = null
                        },
                    )
                }
                if (methods.isNotEmpty()) MenuDivider()
                MenuChoice(
                    "Amazon Bedrock…",
                    selected = false,
                    subtitle = "Set up in Settings › Model providers",
                    icon = Icons.Outlined.Cloud,
                    onClick = onBedrock,
                )
            }
            val m = method
            if (m == null) {
                Text("This agent signs in through a model provider.", style = OptioTheme.type.footnote, color = colors.secondaryLabel)
            } else {
                val token = m.input == AgentCredentialInput.TOKEN
                OutlinedTextField(
                    value = value,
                    onValueChange = {
                        value = it
                        checked = null
                        failure = null
                    },
                    label = {
                        Text(
                            when (m.input) {
                                AgentCredentialInput.TOKEN -> "Key or token"
                                AgentCredentialInput.URL -> "URL"
                                AgentCredentialInput.PROJECT -> "Project id"
                                AgentCredentialInput.UNKNOWN -> "Value"
                            },
                        )
                    },
                    singleLine = true,
                    visualTransformation = if (token) PasswordVisualTransformation() else VisualTransformation.None,
                    keyboardOptions = KeyboardOptions(
                        keyboardType = when (m.input) {
                            AgentCredentialInput.TOKEN -> KeyboardType.Password
                            AgentCredentialInput.URL -> KeyboardType.Uri
                            else -> KeyboardType.Text
                        },
                        autoCorrectEnabled = false,
                    ),
                    modifier = Modifier.fillMaxWidth().testTag("work-form-new-credential-value"),
                )
                m.hint?.takeIf { it.isNotBlank() }?.let { Text(it, style = OptioTheme.type.footnote, color = colors.secondaryLabel) }
                if (allowOrganization) {
                    SegmentedRow(
                        options = WorkOwner.entries.map { it to it.label },
                        selection = owner,
                        onSelect = { owner = it },
                    )
                } else {
                    Text(
                        "Saved as private: only you see it, and only your work can use it.",
                        style = OptioTheme.type.footnote,
                        color = colors.secondaryLabel,
                    )
                }
                checked?.let { r ->
                    Text(
                        if (r.valid) "Works" + (r.detail?.let { " · $it" } ?: "") else "Didn't work: ${r.error ?: "the service rejected it"}",
                        style = OptioTheme.type.footnote,
                        color = if (r.valid) colors.green else colors.red,
                    )
                }
                failure?.let { Text(it, style = OptioTheme.type.footnote, color = colors.red) }
                Row(Modifier.fillMaxWidth(), horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
                    if (m.verifiable) {
                        OutlinedButton(
                            onClick = { scope.launch { checked = onVerify(m.secretName, value) } },
                            enabled = !verifying && !busy && value.isNotEmpty(),
                            modifier = Modifier.weight(1f).testTag("work-form-new-credential-test"),
                        ) { Text(if (verifying) "Testing…" else "Test") }
                    }
                    Button(
                        onClick = {
                            failure = null
                            onCreate(m.secretName, value, owner == WorkOwner.ME || !allowOrganization, m.verifiable) { err ->
                                if (err == null) onDismiss() else failure = err
                            }
                        },
                        enabled = !busy && value.isNotEmpty(),
                        modifier = Modifier.weight(1f).testTag("work-form-new-credential-save"),
                    ) { Text(if (busy) "Saving…" else "Save and pick") }
                }
            }
        }
    }
}

// endregion
