package dev.optio.feature.more.webhooks

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.outlined.Send
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.Webhook
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.navigation.routes.NewWebhookRoute
import dev.optio.core.navigation.routes.WebhookDetailRoute
import dev.optio.core.network.LocalApiClient
import dev.optio.core.ui.auth.Roles
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.OptioRow
import dev.optio.core.ui.components.mono
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.feature.more.api.WebhookRow
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem

/** `WebhooksRoute` (iOS `WebhooksListView`). */
@Composable
fun WebhooksScreen() {
    val api = LocalApiClient.current
    val navigator = LocalNavigator.current
    val viewModel = viewModel { WebhooksViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val canMutate = Roles.canMutate
    CollectNotices(viewModel.notices)
    // Runs again when the screen comes back from a detail or the new-webhook form: fresh list.
    LaunchedEffect(viewModel) { viewModel.load() }
    MoreScaffold(
        "Webhooks",
        actions = {
            if (canMutate) {
                IconButton(onClick = { navigator.push(NewWebhookRoute) }, modifier = Modifier.testTag("add-webhook")) {
                    Icon(Icons.Outlined.Add, contentDescription = "New webhook")
                }
            }
        },
    ) { padding ->
        WebhooksContent(
            state = state,
            canMutate = canMutate,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onOpen = { navigator.push(WebhookDetailRoute(it.id)) },
            onTest = viewModel::test,
            onDelete = viewModel::delete,
        )
    }
}

/** The webhook list, stateless. */
@Composable
fun WebhooksContent(
    state: LoadState<List<WebhookRow>>,
    canMutate: Boolean,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onOpen: (WebhookRow) -> Unit,
    onTest: (WebhookRow) -> Unit,
    onDelete: (WebhookRow) -> Unit,
    modifier: Modifier = Modifier,
) {
    val confirm = rememberConfirmState()
    Loadable(state = state, onRetry = onRetry, what = "webhooks", contentPadding = contentPadding, modifier = modifier) { webhooks ->
        val now = rememberNow()
        LazyColumn(Modifier.fillMaxSize().testTag("webhooks"), contentPadding = contentPadding) {
            if (webhooks.isEmpty()) {
                item(key = "empty") {
                    EmptyState(
                        title = "No webhooks",
                        icon = Icons.Outlined.Webhook,
                        message = "Subscribe to Optio events and get an HTTP POST when they fire.",
                    )
                }
            } else {
                groupedItem("list") {
                    webhooks.forEachIndexed { index, webhook ->
                        if (index > 0) InsetDivider()
                        WebhookItem(
                            webhook = webhook,
                            trailing = if (webhook.isPaused) "Paused" else webhook.createdAt?.relativeDescription(now),
                            canMutate = canMutate,
                            onOpen = { onOpen(webhook) },
                            onTest = { onTest(webhook) },
                            onDelete = {
                                confirm.ask(
                                    title = "Delete this webhook?",
                                    message = "Delivery history will be lost.",
                                    confirmLabel = "Delete",
                                    destructive = true,
                                ) { onDelete(webhook) }
                            },
                        )
                    }
                }
            }
            groupedItem("details", header = "Delivery details") {
                Column(Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m), verticalArrangement = Arrangement.spacedBy(6.dp)) {
                    DELIVERY_DETAILS.forEach {
                        Text(it, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
                    }
                }
            }
            bottomSpacer()
        }
    }
    ConfirmHost(confirm)
}

/** iOS's "Delivery details" section, verbatim. */
internal val DELIVERY_DETAILS = listOf(
    "Each delivery POSTs JSON with X-Optio-Event and, when a secret is set, X-Optio-Signature (HMAC-SHA256).",
    "Slack incoming webhook URLs are auto-detected and sent as formatted blocks.",
    "Failed deliveries retry up to 3 times (5s, 10s, 20s) with a 10s timeout per attempt.",
)

/**
 * One webhook row: tap opens it; for members a long-press offers Send test and Delete (iOS swipe
 * actions; the detail screen has every action too).
 */
@Composable
private fun WebhookItem(
    webhook: WebhookRow,
    trailing: String?,
    canMutate: Boolean,
    onOpen: () -> Unit,
    onTest: () -> Unit,
    onDelete: () -> Unit,
) {
    var menu by remember { mutableStateOf(false) }
    Box {
        OptioRow(
            title = webhook.description?.takeIf { it.isNotEmpty() } ?: webhook.url ?: webhook.id,
            meta = mono(webhook.url ?: webhook.id),
            trailing = trailing,
            trailingTone = if (webhook.isPaused) Tone.IDLE else null,
            footer = eventsSummary(webhook.events.orEmpty())?.let(::mono),
            titleMaxLines = 1,
            onClick = onOpen,
            onLongClick = if (canMutate) ({ menu = true }) else null,
            modifier = Modifier.testTag("webhook-${webhook.id}"),
        )
        DropdownMenu(expanded = menu, onDismissRequest = { menu = false }, modifier = Modifier.testTag("webhook-menu-${webhook.id}")) {
            DropdownMenuItem(
                text = { Text("Send test") },
                leadingIcon = { Icon(Icons.AutoMirrored.Outlined.Send, contentDescription = null) },
                onClick = {
                    menu = false
                    onTest()
                },
            )
            DropdownMenuItem(
                text = { Text("Delete", color = OptioTheme.colors.red) },
                leadingIcon = { Icon(Icons.Outlined.Delete, contentDescription = null, tint = OptioTheme.colors.red) },
                onClick = {
                    menu = false
                    onDelete()
                },
            )
        }
    }
}
