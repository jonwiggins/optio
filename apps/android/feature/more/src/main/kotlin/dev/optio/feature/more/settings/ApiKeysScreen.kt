package dev.optio.feature.more.settings

import android.os.Build
import androidx.compose.foundation.background
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
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.Add
import androidx.compose.material.icons.outlined.ContentCopy
import androidx.compose.material.icons.outlined.Delete
import androidx.compose.material.icons.outlined.VpnKey
import androidx.compose.material3.DatePicker
import androidx.compose.material3.DatePickerDialog
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.SelectableDates
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.rememberDatePickerState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.viewmodel.compose.viewModel
import dev.optio.core.network.LocalApiClient
import dev.optio.core.network.LocalCurrentUser
import dev.optio.core.ui.components.CodeBlock
import dev.optio.core.ui.components.ConfirmHost
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.components.copyToClipboard
import dev.optio.core.ui.components.rememberConfirmState
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.format.relativeDescription
import dev.optio.core.ui.format.rememberNow
import dev.optio.core.ui.state.LoadState
import dev.optio.core.ui.state.Loadable
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import dev.optio.feature.more.api.ApiKeyRow
import dev.optio.feature.more.api.CreatedApiKey
import dev.optio.feature.more.ui.AuthDisabledState
import dev.optio.feature.more.ui.CollectNotices
import dev.optio.feature.more.ui.MoreScaffold
import dev.optio.feature.more.ui.MoreSheet
import dev.optio.feature.more.ui.SwitchRow
import dev.optio.feature.more.ui.bottomSpacer
import dev.optio.feature.more.ui.groupedItem
import java.time.Instant
import java.time.LocalDate
import java.time.LocalTime
import java.time.ZoneOffset
import java.time.format.DateTimeFormatter
import java.time.format.FormatStyle
import kotlinx.coroutines.launch

/** `ApiKeysRoute` (iOS `ApiKeysView`, "Access Tokens"). */
@Composable
fun ApiKeysScreen() {
    val api = LocalApiClient.current
    val authDisabled = LocalCurrentUser.current?.authDisabled == true
    val viewModel = viewModel { ApiKeysViewModel(api) }
    val state by viewModel.state.collectAsStateWithLifecycle()
    val created by viewModel.created.collectAsStateWithLifecycle()
    val creating by viewModel.creating.collectAsStateWithLifecycle()
    var showCreate by rememberSaveable { mutableStateOf(false) }
    CollectNotices(viewModel.notices)
    // Auth-disabled servers have no accounts, so no tokens: don't ask for a guaranteed 401.
    LaunchedEffect(viewModel, authDisabled) { if (!authDisabled) viewModel.load() }

    MoreScaffold(
        "Access Tokens",
        actions = {
            if (!authDisabled) {
                IconButton(onClick = { showCreate = true }, modifier = Modifier.testTag("new-token")) {
                    Icon(Icons.Outlined.Add, contentDescription = "New token")
                }
            }
        },
    ) { padding ->
        ApiKeysContent(
            state = state,
            authDisabled = authDisabled,
            currentToken = viewModel.currentToken,
            contentPadding = padding,
            onRetry = viewModel::refresh,
            onRevoke = viewModel::revoke,
        )
    }

    if (showCreate || created != null) {
        CreateApiKeySheet(
            created = created,
            creating = creating,
            onCreate = { name, expiresAt -> viewModel.create(name, defaultTokenName(), expiresAt) },
            onCancel = { showCreate = false },
            onDone = {
                showCreate = false
                viewModel.finishCreate()
            },
        )
    }
}

/** iOS names an unnamed token "iOS (<device>)". */
internal fun defaultTokenName(): String = "Android (${Build.MODEL})"

/** The token list, stateless. */
@Composable
fun ApiKeysContent(
    state: LoadState<List<ApiKeyRow>>,
    authDisabled: Boolean,
    currentToken: String?,
    contentPadding: PaddingValues,
    onRetry: () -> Unit,
    onRevoke: (ApiKeyRow) -> Unit,
    modifier: Modifier = Modifier,
) {
    val confirm = rememberConfirmState()
    // The screen skips the load there; a 401 while the user was still unknown lands here too.
    if (authDisabled) {
        Box(modifier.fillMaxSize().padding(contentPadding)) { AuthDisabledState("personal access tokens") }
        return
    }
    Loadable(state = state, onRetry = onRetry, what = "access tokens", contentPadding = contentPadding, modifier = modifier) { keys ->
        if (keys.isEmpty()) {
            LazyColumn(Modifier.fillMaxSize(), contentPadding = contentPadding) {
                item {
                    EmptyState(
                        title = "No tokens",
                        icon = Icons.Outlined.VpnKey,
                        message = "Create a token to sign in from the CLI or another device.",
                    )
                }
            }
        } else {
            LazyColumn(Modifier.fillMaxSize().testTag("api-keys"), contentPadding = contentPadding) {
                groupedItem("keys", footer = "Revoking the token this app signed in with will sign you out.") {
                    keys.forEachIndexed { index, key ->
                        if (index > 0) InsetDivider()
                        ApiKeyItem(
                            key = key,
                            isThisApp = currentToken != null && key.prefix != null && currentToken.startsWith(key.prefix),
                            onRevoke = {
                                confirm.ask(
                                    title = "Revoke \"${key.name ?: "token"}\"?",
                                    message = "Anything using this token will stop working immediately.",
                                    confirmLabel = "Revoke",
                                    destructive = true,
                                ) { onRevoke(key) }
                            },
                        )
                    }
                }
                bottomSpacer()
            }
        }
    }
    ConfirmHost(confirm)
}

@Composable
private fun ApiKeyItem(
    key: ApiKeyRow,
    isThisApp: Boolean,
    onRevoke: () -> Unit,
) {
    val colors = OptioTheme.colors
    val now = rememberNow()
    Row(
        Modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.xs, top = Spacing.s, bottom = Spacing.s).testTag("key-${key.id}"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(3.dp)) {
            Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                Text(key.name ?: "API key", style = OptioTheme.type.subheadline, color = colors.label, maxLines = 1, overflow = TextOverflow.Ellipsis)
                if (isThisApp) {
                    Text(
                        "this app",
                        style = OptioTheme.type.caption2,
                        color = colors.accent,
                        modifier = Modifier.background(colors.accent.copy(alpha = 0.15f), Radius.capsuleShape).padding(horizontal = 6.dp, vertical = 2.dp),
                    )
                }
            }
            key.prefix?.let { Text("$it…", style = OptioTheme.type.monoCaption, color = colors.secondaryLabel) }
            Text(
                listOfNotNull(
                    key.createdAt?.let { "created ${it.relativeDescription(now)}" },
                    key.lastUsedAt?.let { "used ${it.relativeDescription(now)}" } ?: "never used",
                    key.expiresAt?.let { "expires ${it.relativeDescription(now)}" },
                ).joinToString("  "),
                style = OptioTheme.type.caption2,
                color = colors.tertiaryLabel,
            )
        }
        IconButton(onClick = onRevoke, modifier = Modifier.testTag("revoke-${key.id}")) {
            Icon(Icons.Outlined.Delete, contentDescription = "Revoke", tint = colors.secondaryLabel)
        }
    }
}

/**
 * New token (iOS `CreateApiKeySheet`): a name and an optional expiry; once created, the whole
 * token with a copy button and no way out but Done.
 */
@Composable
fun CreateApiKeySheet(
    created: CreatedApiKey?,
    creating: Boolean,
    onCreate: (name: String, expiresAt: Instant?) -> Unit,
    onCancel: () -> Unit,
    onDone: () -> Unit,
) {
    val clock = LocalClock.current
    var name by rememberSaveable { mutableStateOf("") }
    var expires by rememberSaveable { mutableStateOf(false) }
    val defaultDay = remember(clock) { LocalDate.now(clock).plusDays(90) }
    var expiresOn by rememberSaveable { mutableLongStateOf(defaultDay.toEpochDay()) }
    // One sheet throughout: the form, then the token with no way out but Done.
    MoreSheet(
        title = if (created == null) "New Token" else "Token Created",
        onDismiss = if (created == null) onCancel else onDone,
        dismissLabel = if (created == null) "Cancel" else null,
        confirmLabel = if (created == null) "Create" else "Done",
        busy = creating,
        dismissible = created == null,
        onConfirm = {
            if (created != null) {
                onDone()
            } else {
                val expiry = if (expires) LocalDate.ofEpochDay(expiresOn).atTime(LocalTime.now(clock)).atZone(clock.zone).toInstant() else null
                onCreate(name, expiry)
            }
        },
    ) {
        if (created == null) {
            CreateApiKeyForm(
                name = name,
                onName = { name = it },
                expires = expires,
                onExpires = { expires = it },
                expiresOn = LocalDate.ofEpochDay(expiresOn),
                onExpiresOn = { expiresOn = it.toEpochDay() },
            )
        } else {
            CreatedTokenView(created)
        }
    }
}

/** The name / expiry form, stateless. */
@Composable
fun CreateApiKeyForm(
    name: String,
    onName: (String) -> Unit,
    expires: Boolean,
    onExpires: (Boolean) -> Unit,
    expiresOn: LocalDate,
    onExpiresOn: (LocalDate) -> Unit,
    modifier: Modifier = Modifier,
) {
    var pickDate by remember { mutableStateOf(false) }
    val clock = LocalClock.current
    Column(modifier.fillMaxWidth()) {
        OutlinedTextField(
            value = name,
            onValueChange = onName,
            label = { Text("Name") },
            placeholder = { Text("e.g. Pixel 9") },
            singleLine = true,
            modifier = Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s).testTag("token-name"),
        )
        SwitchRow("Expires", checked = expires, onCheckedChange = onExpires, modifier = Modifier.testTag("token-expires"))
        if (expires) {
            Row(
                Modifier.fillMaxWidth().padding(horizontal = Spacing.l),
                verticalAlignment = Alignment.CenterVertically,
            ) {
                Text("Expires on", style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
                TextButton(onClick = { pickDate = true }, modifier = Modifier.testTag("token-expires-on")) {
                    Text(expiresOn.format(DateTimeFormatter.ofLocalizedDate(FormatStyle.MEDIUM)))
                }
            }
        }
        Text(
            "Tokens start with optio_pat_ and are sent as a bearer header, like the CLI.",
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
            modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
        )
    }
    if (pickDate) {
        val today = LocalDate.now(clock)
        val state = rememberDatePickerState(
            initialSelectedDateMillis = expiresOn.atStartOfDay(ZoneOffset.UTC).toInstant().toEpochMilli(),
            selectableDates = object : SelectableDates {
                override fun isSelectableDate(utcTimeMillis: Long): Boolean =
                    !Instant.ofEpochMilli(utcTimeMillis).atZone(ZoneOffset.UTC).toLocalDate().isBefore(today)

                override fun isSelectableYear(year: Int): Boolean = year >= today.year
            },
        )
        DatePickerDialog(
            onDismissRequest = { pickDate = false },
            confirmButton = {
                TextButton(onClick = {
                    state.selectedDateMillis?.let { onExpiresOn(Instant.ofEpochMilli(it).atZone(ZoneOffset.UTC).toLocalDate()) }
                    pickDate = false
                }) { Text("OK") }
            },
            dismissButton = { TextButton(onClick = { pickDate = false }) { Text("Cancel") } },
        ) {
            DatePicker(state = state)
        }
    }
}

/** "Your new token": the whole token once, with Copy. */
@Composable
fun CreatedTokenView(
    created: CreatedApiKey,
    modifier: Modifier = Modifier,
) {
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val scope = rememberCoroutineScope()
    Column(modifier.fillMaxWidth().padding(horizontal = Spacing.l), verticalArrangement = Arrangement.spacedBy(Spacing.s)) {
        Text("Your new token", style = OptioTheme.type.sectionHeader, color = OptioTheme.colors.secondaryLabel, modifier = Modifier.padding(top = Spacing.s))
        CodeBlock(created.token, background = OptioTheme.colors.card, padding = Spacing.m, modifier = Modifier.testTag("created-token"))
        FilledTonalButton(
            onClick = {
                scope.launch {
                    copyToClipboard(clipboard, created.token, label = "Optio token")
                    toaster.success("Copied")
                }
            },
            modifier = Modifier.testTag("copy-token"),
        ) {
            Icon(Icons.Outlined.ContentCopy, contentDescription = null, modifier = Modifier.size(18.dp))
            Text("Copy token", modifier = Modifier.padding(start = Spacing.s))
        }
        Text(
            "This is the only time the full token is shown. Store it somewhere safe.",
            style = OptioTheme.type.footnote,
            color = OptioTheme.colors.secondaryLabel,
        )
    }
}
