package dev.optio.feature.local.automations

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ModalBottomSheet
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
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.theme.semibold
import dev.optio.core.ui.triggers.TriggerDraft
import dev.optio.core.ui.triggers.TriggerRows
import dev.optio.core.ui.triggers.TriggerSecretDialog
import dev.optio.core.ui.triggers.TriggerSpec
import dev.optio.core.ui.triggers.TriggerTypeChips
import dev.optio.core.ui.triggers.WhenType
import dev.optio.core.ui.triggers.selfSecretPath
import dev.optio.feature.local.api.LocalTrigger
import dev.optio.feature.local.model.Triggers
import kotlin.coroutines.cancellation.CancellationException
import kotlinx.coroutines.launch

/**
 * Add trigger (iOS `AddTriggerSheet`, web `AddTriggerForm`): pick what starts the automation,
 * fill in that kind's rows (the same editor as the New work form), and Add. Every trigger type but
 * manual: a schedule, a webhook, a ticket filter, or a GitHub / GitLab / Slack / Linear / Jira /
 * Pylon / PagerDuty / Sentry / Alertmanager / Datadog event. [serverUrl] shows where a webhook
 * listens; a Pylon / Alertmanager / Datadog trigger's own URL and secret are shown once after it
 * is created. [onSubmit] returns the created row (its config carries the secret, once).
 */
@Composable
internal fun AddTriggerSheet(
    serverUrl: String?,
    onDismiss: () -> Unit,
    onSubmit: suspend (TriggerSpec) -> LocalTrigger,
) {
    val sheet = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    val scope = rememberCoroutineScope()
    var draft by remember { mutableStateOf(TriggerDraft.of(WhenType.SCHEDULE)) }
    var saving by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    var created by remember { mutableStateOf<LocalTrigger?>(null) }
    val origin = serverUrl?.trimEnd('/')

    fun close() {
        scope.launch { sheet.hide() }.invokeOnCompletion { onDismiss() }
    }

    fun submit() {
        val spec = draft.spec() ?: return
        saving = true
        error = null
        scope.launch {
            try {
                val trigger = onSubmit(spec)
                if (Triggers.createdSecret(trigger) != null) created = trigger else close()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                error = ErrorText.humanize(e, "trigger")
            } finally {
                saving = false
            }
        }
    }

    created?.let { trigger ->
        val type = draft.whenType.event ?: return@let
        TriggerSecretDialog(
            type = type,
            url = (origin ?: "") + selfSecretPath(type, trigger.id),
            secret = Triggers.createdSecret(trigger).orEmpty(),
            onDismiss = {
                created = null
                close()
            },
        )
    }

    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheet, modifier = Modifier.testTag("add-trigger-sheet")) {
        Column(
            Modifier
                .fillMaxWidth()
                .verticalScroll(rememberScrollState())
                .navigationBarsPadding(),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
        ) {
            Text("Add trigger", style = OptioTheme.type.title3.semibold(), modifier = Modifier.padding(horizontal = Spacing.l))
            TriggerTypeChips(
                selected = draft.whenType,
                onSelect = {
                    draft = draft.select(it)
                    error = null
                },
                tagPrefix = "trigger-kind",
                modifier = Modifier.padding(horizontal = Spacing.l),
            )
            // The rows sit on a card, as they do in the New work form.
            Column(
                Modifier
                    .padding(horizontal = Spacing.l)
                    .fillMaxWidth()
                    .background(OptioTheme.colors.card, Radius.innerShape)
                    .padding(bottom = Spacing.xs),
            ) {
                TriggerRows(draft = draft, onChange = { draft = it }, tagPrefix = "trigger")
                if (draft.whenType == WhenType.WEBHOOK && origin != null) {
                    val path = draft.trigger.webhookPath.orEmpty().trim()
                    if (path.isNotEmpty()) {
                        Text(
                            "POST $origin/api/hooks/$path",
                            style = OptioTheme.type.caption.mono(),
                            color = OptioTheme.colors.secondaryLabel,
                            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
                        )
                    }
                }
            }
            val problem = draft.problem
            Text(
                error ?: draft.footer("starts a run"),
                style = OptioTheme.type.footnote,
                color = if (error != null || problem != null) OptioTheme.colors.red else OptioTheme.colors.secondaryLabel,
                modifier = Modifier.padding(horizontal = Spacing.l).testTag(if (error != null) "trigger-error" else "trigger-footer"),
            )
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l).padding(bottom = Spacing.l),
                horizontalArrangement = Arrangement.spacedBy(Spacing.s, Alignment.End),
            ) {
                TextButton(onClick = ::close) { Text("Cancel") }
                Button(onClick = ::submit, enabled = draft.isValid && !saving, modifier = Modifier.testTag("trigger-add")) {
                    if (saving) CircularProgressIndicator(Modifier.size(16.dp), strokeWidth = 2.dp) else Text("Add")
                }
            }
        }
    }
}
