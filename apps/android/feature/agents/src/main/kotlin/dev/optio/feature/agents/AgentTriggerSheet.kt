package dev.optio.feature.agents

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.SheetState
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.triggers.TriggerDraft
import dev.optio.core.ui.triggers.TriggerRows
import dev.optio.core.ui.triggers.TriggerSecretDialog
import dev.optio.core.ui.triggers.TriggerTypeChips
import dev.optio.core.ui.triggers.WhenType
import dev.optio.core.ui.triggers.selfSecretPath
import kotlinx.coroutines.launch

/**
 * "New trigger" (iOS `AgentTriggerSheet`, widened to the fourteen trigger types the API takes for
 * an agent): a type picker, the type's rows (the same editor as the New work form), and Create.
 * [onCreate] returns the saved row; the sheet then closes, or first shows a Pylon / Alertmanager /
 * Datadog trigger's own URL and secret once.
 */
@Composable
internal fun AgentTriggerSheet(
    onDismiss: () -> Unit,
    onCreate: suspend (TriggerDraft) -> Result<PersistentAgentTrigger>,
    sheetState: SheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true),
) {
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(TriggerDraft.of(WhenType.SCHEDULE).let { it.copy(trigger = it.trigger.copy(cronExpression = "0 9 * * 1-5")) }) }
    var saving by remember { mutableStateOf(false) }
    // Why the server refused the last Create (iOS shows it in the sheet): a 409 "path already in use".
    var error by remember { mutableStateOf<String?>(null) }
    var created by remember { mutableStateOf<PersistentAgentTrigger?>(null) }
    val origin = LocalApiClient.current.baseUrl?.toString()?.removeSuffix("/")

    fun close() {
        scope.launch { sheetState.hide() }.invokeOnCompletion { onDismiss() }
    }

    created?.let { trigger ->
        val type = draft.whenType.event ?: return@let
        TriggerSecretDialog(
            type = type,
            url = (origin ?: "") + selfSecretPath(type, trigger.id),
            secret = trigger.createdSecret.orEmpty(),
            onDismiss = {
                created = null
                close()
            },
        )
    }

    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("trigger-sheet"),
    ) {
        AgentTriggerForm(
            draft = draft,
            onChange = {
                draft = it
                error = null
            },
            saving = saving,
            error = error,
            onCancel = ::close,
            onCreate = {
                scope.launch {
                    saving = true
                    error = null
                    val result = onCreate(draft)
                    saving = false
                    result.fold(
                        onSuccess = { trigger -> if (trigger.createdSecret != null) created = trigger else close() },
                        onFailure = { error = ErrorText.humanize(it) },
                    )
                }
            },
        )
    }
}

/** The sheet's body, stateless (screenshots render it without a sheet). */
@Composable
internal fun AgentTriggerForm(
    draft: TriggerDraft,
    onChange: (TriggerDraft) -> Unit,
    saving: Boolean,
    onCancel: () -> Unit,
    onCreate: () -> Unit,
    modifier: Modifier = Modifier,
    error: String? = null,
) {
    val colors = OptioTheme.colors
    Column(
        modifier
            .fillMaxWidth()
            .verticalScroll(rememberScrollState())
            .padding(bottom = Spacing.xl),
        verticalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Row(Modifier.padding(horizontal = Spacing.s), verticalAlignment = Alignment.CenterVertically) {
            TextButton(onClick = onCancel, modifier = Modifier.testTag("trigger-cancel")) { Text("Cancel") }
            Text(
                "New trigger",
                style = OptioTheme.type.headline,
                color = colors.label,
                modifier = Modifier.weight(1f),
                textAlign = TextAlign.Center,
            )
            Button(
                onClick = onCreate,
                enabled = draft.isValid && !saving,
                modifier = Modifier.testTag("trigger-create"),
            ) { Text(if (saving) "Saving…" else "Create") }
        }

        // Every type the API takes for an agent, Manual last (messages always wake it).
        TriggerTypeChips(
            selected = draft.whenType,
            onSelect = { onChange(draft.select(it)) },
            types = WhenType.forSheet(withManual = false) + WhenType.MANUAL,
            tagPrefix = "trigger-type",
            modifier = Modifier.padding(horizontal = Spacing.l),
        )

        if (draft.whenType != WhenType.MANUAL) {
            Column(
                Modifier
                    .padding(horizontal = Spacing.l)
                    .fillMaxWidth()
                    .background(colors.card, Radius.innerShape)
                    .padding(bottom = Spacing.xs),
            ) {
                TriggerRows(draft = draft, onChange = onChange, tagPrefix = "trigger", leadingDivider = false)
            }
        }

        if (error != null) {
            Text(error, style = OptioTheme.type.footnote, color = colors.red, modifier = Modifier.padding(horizontal = Spacing.l).testTag("trigger-error"))
        }
        val problem = draft.problem
        Text(
            draft.footer("wakes the agent"),
            style = OptioTheme.type.footnote,
            color = if (problem != null) colors.red else colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.l).testTag("trigger-footer"),
        )
    }
}
