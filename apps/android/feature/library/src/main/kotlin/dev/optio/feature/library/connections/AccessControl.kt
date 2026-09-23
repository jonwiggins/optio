package dev.optio.feature.library.connections

import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.theme.Spacing
import dev.optio.feature.library.AgentTypes
import dev.optio.feature.library.ConnectionAssignmentInput
import dev.optio.feature.library.GroupedCard
import dev.optio.feature.library.Permissions
import dev.optio.feature.library.PickerRow
import dev.optio.feature.library.RepoRow
import dev.optio.feature.library.SheetHeader
import dev.optio.feature.library.SwitchRow

/** Who receives a connection (iOS `AccessControlFields` state): a repo or all, agents or all, a permission. */
data class AccessControl(
    /** "" = all repos. */
    val repoId: String = "",
    /** Empty = every agent type. */
    val agentTypes: Set<String> = emptySet(),
    val permission: String = "read",
) {
    fun toggling(agentType: String, on: Boolean): AccessControl =
        copy(agentTypes = if (on) agentTypes + agentType else agentTypes - agentType)

    /** The assignment to create; agent types in the catalogue's order, like iOS. */
    fun assignment(): ConnectionAssignmentInput = ConnectionAssignmentInput(
        repoId = repoId.ifEmpty { null },
        agentTypes = AgentTypes.all.map { it.first }.filter { it in agentTypes },
        permission = permission,
    )
}

/** Permission, repo and agent-type rows (iOS `AccessControlFields`), inside a card. */
@Composable
internal fun AccessControlFields(
    repos: List<RepoRow>,
    access: AccessControl,
    onChange: (AccessControl) -> Unit,
) {
    PickerRow(
        "Permission",
        Permissions.all,
        access.permission,
        { onChange(access.copy(permission = it)) },
        modifier = Modifier.testTag("access-permission"),
    )
    InsetDivider()
    PickerRow(
        "Repo",
        listOf("" to "All repos") + repos.map { it.id to it.displayName },
        access.repoId,
        { onChange(access.copy(repoId = it)) },
        modifier = Modifier.testTag("access-repo"),
    )
    AgentTypes.all.forEach { (type, label) ->
        InsetDivider()
        SwitchRow(
            label,
            type in access.agentTypes,
            { onChange(access.toggling(type, it)) },
            modifier = Modifier.testTag("access-agent-$type"),
        )
    }
}

/** A new assignment (iOS `NewAssignmentSheet`): the access-control fields and Add. */
@Composable
internal fun NewAssignmentForm(
    repos: List<RepoRow>,
    saving: Boolean,
    onCancel: () -> Unit,
    onSave: (AccessControl) -> Unit,
    modifier: Modifier = Modifier,
    initial: AccessControl = AccessControl(),
) {
    var access by remember { mutableStateOf(initial) }
    Column(modifier.fillMaxWidth().verticalScroll(rememberScrollState()).padding(bottom = Spacing.xl)) {
        SheetHeader(
            title = "New Assignment",
            onCancel = onCancel,
            confirmLabel = "Add",
            confirmEnabled = true,
            busy = saving,
            onConfirm = { onSave(access) },
        )
        GroupedCard(footer = "Leave all agent toggles off to allow every agent type.") {
            AccessControlFields(repos, access) { access = it }
        }
    }
}
