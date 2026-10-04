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
import dev.optio.core.model.PickableSecret
import dev.optio.core.network.isOrganization
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
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
