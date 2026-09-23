package dev.optio.feature.more.webhooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.listSaver
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.semibold
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreWebhookEvents
import dev.optio.feature.more.ui.SwitchRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `NewWebhookRoute` (iOS `NewWebhookSheet`): a full-screen form, Create in the top bar. */
@Composable
fun NewWebhookScreen() {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel { NewWebhookViewModel(api) }
    val saving by viewModel.saving.collectAsStateWithLifecycle()
    var draft by rememberSaveable(stateSaver = WebhookDraftSaver) { mutableStateOf(WebhookDraft()) }
    // The signing secret is never saved into instance state.
    var secret by remember { mutableStateOf("") }
    CollectNotices(viewModel.notices)
    MoreScaffold(
        "New Webhook",
        actions = {
            if (saving) {
                CircularProgressIndicator(Modifier.padding(end = Spacing.l).size(20.dp), strokeWidth = 2.dp)
            } else {
                TextButton(
                    onClick = { viewModel.create(draft.input(secret)) { navigator.pop() } },
                    enabled = draft.canSave(),
                    modifier = Modifier.testTag("create-webhook"),
                ) {
                    Text("Create", style = OptioTheme.type.body.semibold())
                }
            }
        },
    ) { padding ->
        NewWebhookForm(
            draft = draft,
            secret = secret,
            contentPadding = padding,
            onDraft = { draft = it },
            onSecret = { secret = it },
        )
    }
}

/** The form, stateless. */
@Composable
fun NewWebhookForm(
    draft: WebhookDraft,
    secret: String,
    contentPadding: PaddingValues,
    onDraft: (WebhookDraft) -> Unit,
    onSecret: (String) -> Unit,
    modifier: Modifier = Modifier,
) {
    LazyColumn(modifier.fillMaxSize().testTag("new-webhook"), contentPadding = contentPadding) {
        groupedItem(
            "target",
            footer = "Must be a public HTTPS URL — private/internal addresses are blocked. When a secret is set, deliveries include an X-Optio-Signature header.",
        ) {
            Column(Modifier.fillMaxWidth().padding(Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
                OutlinedTextField(
                    value = draft.url,
                    onValueChange = { onDraft(draft.copy(url = it)) },
                    placeholder = { Text("https://example.com/webhook") },
                    singleLine = true,
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Uri, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().testTag("webhook-url"),
                )
                OutlinedTextField(
                    value = draft.description,
                    onValueChange = { onDraft(draft.copy(description = it)) },
                    placeholder = { Text("Description (optional)") },
                    singleLine = true,
                    modifier = Modifier.fillMaxWidth().testTag("webhook-description"),
                )
                OutlinedTextField(
                    value = secret,
                    onValueChange = onSecret,
                    placeholder = { Text("Secret (optional, HMAC-SHA256)") },
                    singleLine = true,
                    visualTransformation = PasswordVisualTransformation(),
                    keyboardOptions = KeyboardOptions(keyboardType = KeyboardType.Password, autoCorrectEnabled = false),
                    modifier = Modifier.fillMaxWidth().testTag("webhook-secret"),
                )
            }
        }
        MoreWebhookEvents.groups.forEach { (group, events) ->
            groupedItem("events-$group", header = group) {
                events.forEachIndexed { index, event ->
                    if (index > 0) InsetDivider()
                    SwitchRow(
                        title = event,
                        mono = true,
                        checked = event in draft.events,
                        onCheckedChange = { on -> onDraft(draft.copy(events = if (on) draft.events + event else draft.events - event)) },
                        modifier = Modifier.testTag("event-$event"),
                    )
                }
            }
        }
        bottomSpacer()
    }
}

/** Saves the draft (URL, description, events) across rotation and process death; never the secret. */
internal val WebhookDraftSaver = listSaver<WebhookDraft, Any>(
    save = { listOf(it.url, it.description, ArrayList(it.events)) },
    restore = {
        @Suppress("UNCHECKED_CAST")
        WebhookDraft(url = it[0] as String, description = it[1] as String, events = (it[2] as List<String>).toSet())
    },
)
