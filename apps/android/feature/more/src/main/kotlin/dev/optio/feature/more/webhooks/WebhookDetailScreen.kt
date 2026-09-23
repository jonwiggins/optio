package dev.optio.feature.more.webhooks

import androidx.compose.animation.animateContentSize
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
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
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.ExpandLess
import androidx.compose.material.icons.filled.ExpandMore
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Pause
import androidx.compose.material.icons.outlined.PlayArrow
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.Dot
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.KeyValueRow
import dev.optio.core.ui.components.SectionHeader
import dev.optio.core.ui.components.StatusBadge
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.WebhookDeliveryRow
import dev.optio.feature.more.ui.CardNote
import dev.optio.feature.more.ui.ChipCloud
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreWebhookEvents
import dev.optio.feature.more.ui.SettingsRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `WebhookDetailRoute(id)` (iOS `WebhookDetailView`). */
@Composable
fun WebhookDetailScreen(webhookId: String) {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel(key = "webhook-$webhookId") { WebhookDetailViewModel(api, webhookId) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val busy by viewModel.busy.collectAsStateWithLifecycle()
    CollectNotices(viewModel.notices)
    LaunchedEffect(viewModel) { viewModel.load() }
    MoreScaffold(state.value?.webhook?.description?.takeIf { it.isNotEmpty() } ?: "Webhook") { padding ->
        WebhookDetailContent(
            state = state,
            canMutate = Roles.canMutate,
            busy = busy,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onTest = viewModel::test,
            onToggle = viewModel::toggleActive,
            onDelete = { viewModel.delete(onDeleted = navigator::pop) },
        )
    }
}

/** A webhook's page, stateless. */
@Composable
fun WebhookDetailContent(
    state: LoadState<WebhookDetail>,
    canMutate: Boolean,
    busy: Boolean,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onTest: (event: String?) -> Unit,
    onToggle: () -> Unit,
    onDelete: () -> Unit,
    modifier: Modifier = Modifier,
    initiallyExpanded: Set<String> = emptySet(),
) {
    val confirm = rememberConfirmState()
    val colors = OptioTheme.colors
    Loadable(state = state, onRetry = onRetry, what = "the webhook", contentPadding = contentPadding, modifier = modifier) { detail ->
        val webhook = detail.webhook
        val now = rememberNow()
        var testEvent by rememberSaveable { mutableStateOf("") }
        var expanded by rememberSaveable { mutableStateOf(initiallyExpanded.toList()) }
        LazyColumn(Modifier.fillMaxSize().testTag("webhook-detail"), contentPadding = contentPadding) {
            groupedItem("summary") {
                Row(
                    Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
                    horizontalArrangement = Arrangement.spacedBy(Spacing.s),
                    verticalAlignment = Alignment.Top,
                ) {
                    Dot(color = if (webhook.isPaused) Tone.IDLE.color else Tone.SUCCESS.color, size = 8.dp, modifier = Modifier.padding(top = 6.dp))
                    SelectionContainer { Text(webhook.url ?: "", style = OptioTheme.type.monoFootnote, color = colors.label) }
                }
                webhook.createdAt?.let {
                    InsetDivider()
                    KeyValueRow("Created", it.relativeDescription(now))
                }
                InsetDivider()
                KeyValueRow("Signing", if (webhook.isSigned) "HMAC-SHA256" else "None")
                InsetDivider()
                KeyValueRow("Status", if (webhook.isPaused) "Disabled" else "Active")
            }
            groupedItem("events", header = "Subscribed events") {
                ChipCloud(webhook.events.orEmpty())
            }
            if (canMutate) {
                groupedItem("test", header = "Test", footer = "Delivers a synthetic sample payload to verify the receiver is reachable.") {
                    TestEventPicker(
                        value = testEvent,
                        defaultEvent = webhook.events?.firstOrNull(),
                        onChange = { testEvent = it },
                    )
                    InsetDivider()
                    SettingsRow(
                        "Send test delivery",
                        icon = Icons.AutoMirrored.Outlined.Send,
                        tint = colors.accent,
                        chevron = false,
                        busy = busy,
                        onClick = { onTest(testEvent.ifEmpty { null }) },
                        modifier = Modifier.testTag("send-test"),
                    )
                }
                groupedItem("actions") {
                    SettingsRow(
                        if (webhook.isPaused) "Enable" else "Disable",
                        icon = if (webhook.isPaused) Icons.Outlined.PlayArrow else Icons.Outlined.Pause,
                        tint = colors.accent,
                        chevron = false,
                        enabled = !busy,
                        onClick = onToggle,
                        modifier = Modifier.testTag("toggle-webhook"),
                    )
                    InsetDivider()
                    SettingsRow(
                        "Delete webhook",
                        icon = Icons.Outlined.Delete,
                        tint = colors.red,
                        chevron = false,
                        enabled = !busy,
                        onClick = {
                            confirm.ask(title = "Delete this webhook and all delivery history?", confirmLabel = "Delete", destructive = true, onConfirm = onDelete)
                        },
                        modifier = Modifier.testTag("delete-webhook"),
                    )
                }
            }
            item(key = "history") {
                DeliveryHistory(
                    deliveries = detail.deliveries,
                    successRate = detail.successRate,
                    expanded = expanded.toSet(),
                    onToggle = { id -> expanded = if (id in expanded) expanded - id else expanded + id },
                    nowText = { it.relativeDescription(now) },
                )
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** iOS test `Picker`: "Default (<first event>)" then every event. */
@Composable
private fun TestEventPicker(
    value: String,
    defaultEvent: String?,
    onChange: (String) -> Unit,
) {
    var open by remember { mutableStateOf(false) }
    val defaultLabel = "Default (${defaultEvent ?: "—"})"
    Row(Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.s), verticalAlignment = Alignment.CenterVertically) {
        Text("Event", style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
        Box {
            TextButton(onClick = { open = true }, modifier = Modifier.testTag("test-event")) {
                Text(value.ifEmpty { defaultLabel }, style = if (value.isEmpty()) OptioTheme.type.body else OptioTheme.type.monoFootnote)
                Icon(Icons.Filled.ExpandMore, contentDescription = null, modifier = Modifier.size(18.dp))
            }
            DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
                (listOf("" to defaultLabel) + MoreWebhookEvents.all.map { it to it }).forEach { (event, label) ->
                    DropdownMenuItem(
                        text = { Text(label, style = if (event.isEmpty()) OptioTheme.type.body else OptioTheme.type.monoFootnote) },
                        trailingIcon = if (event == value) {
                            { Icon(Icons.Filled.Check, contentDescription = "Selected") }
                        } else {
                            null
                        },
                        onClick = {
                            open = false
                            onChange(event)
                        },
                    )
                }
            }
        }
    }
}

/** "Delivery history" with the success rate, each delivery expandable to its payload / response. */
@Composable
private fun DeliveryHistory(
    deliveries: List<WebhookDeliveryRow>,
    successRate: Int?,
    expanded: Set<String>,
    onToggle: (String) -> Unit,
    nowText: (String) -> String,
) {
    Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l)) {
        SectionHeader(
            "Delivery history",
            detail = successRate?.let { "${deliveries.size} · $it% ok" },
            contentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, top = Spacing.l + Spacing.xs, bottom = Spacing.s),
        )
        Column(Modifier.fillMaxWidth().clip(Radius.cardShape).background(OptioTheme.colors.card)) {
            DeliveryRows(deliveries, expanded, onToggle, nowText)
        }
    }
}

@Composable
private fun DeliveryRows(
    deliveries: List<WebhookDeliveryRow>,
    expanded: Set<String>,
    onToggle: (String) -> Unit,
    nowText: (String) -> String,
) {
    if (deliveries.isEmpty()) {
        CardNote("No deliveries yet. Fire a test or trigger a subscribed event.")
        return
    }
    deliveries.forEachIndexed { index, delivery ->
        if (index > 0) InsetDivider()
        DeliveryRow(delivery, expanded = delivery.id in expanded, onToggle = { onToggle(delivery.id) }, nowText = nowText)
    }
}

@Composable
private fun DeliveryRow(
    delivery: WebhookDeliveryRow,
    expanded: Boolean,
    onToggle: () -> Unit,
    nowText: (String) -> String,
) {
    val colors = OptioTheme.colors
    val ok = delivery.success == true
    Column(
        Modifier
            .fillMaxWidth()
            .animateContentSize()
            .clickable(role = Role.Button, onClickLabel = if (expanded) "Collapse" else "Expand", onClick = onToggle)
            .padding(horizontal = Spacing.l, vertical = Spacing.m)
            .testTag("delivery-${delivery.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.s)) {
            StatusBadge(text = if (ok) "ok" else "fail", tone = if (ok) Tone.SUCCESS else Tone.DANGER)
            Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(delivery.event ?: "", style = OptioTheme.type.monoCaption, color = colors.label)
                Text(
                    listOfNotNull(
                        delivery.statusCode?.let { "HTTP $it" },
                        "attempt ${delivery.attempt ?: 1}",
                        delivery.deliveredAt?.let(nowText),
                    ).joinToString("  "),
                    style = OptioTheme.type.caption2,
                    color = colors.tertiaryLabel,
                )
            }
            if (!delivery.error.isNullOrEmpty()) {
                Icon(Icons.Outlined.ErrorOutline, contentDescription = "Error", tint = colors.red, modifier = Modifier.size(18.dp))
            }
            Icon(
                if (expanded) Icons.Filled.ExpandLess else Icons.Filled.ExpandMore,
                contentDescription = null,
                tint = colors.tertiaryLabel,
                modifier = Modifier.size(20.dp),
            )
        }
        if (expanded) {
            delivery.payload?.let {
                Text("Payload", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                CodeBlock(prettyJson(it))
            }
            delivery.responseBody?.takeIf { it.isNotEmpty() }?.let {
                Text("Response body", style = OptioTheme.type.caption, color = colors.secondaryLabel)
                CodeBlock(it.lines().take(30).joinToString("\n"))
            }
            delivery.error?.let { Text(it, style = OptioTheme.type.caption, color = colors.red) }
        }
    }
}
