package dev.optio.feature.more.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.selection.toggleable
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.ArrowBack
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material.icons.outlined.CloudOff
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.ListItem
import androidx.compose.material3.ListItemDefaults
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.lifecycle.ViewModel
import dev.optio.core.navigation.LocalNavigator
import dev.optio.core.network.ApiError
import dev.optio.core.ui.components.EmptyState
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.mono
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.receiveAsFlow

// Shared pieces of the More tab (iOS `MoreSupport.swift`): error copy, a toast channel for
// ViewModels, the settings-style rows every screen here is built from, and the constants mirrored
// from the web UI.

// region Errors and notices

/**
 * Plain-language copy for a failed action (iOS `Error.moreDescription`): a 403 gets the "you don't
 * have permission" hint plus the server's reason; everything else goes through core:ui's
 * [ErrorText.humanize] (server message for 4xx, friendly sentences for transport / 5xx).
 */
fun moreErrorText(error: Throwable): String =
    if (error is ApiError && error.status == ApiError.FORBIDDEN) {
        "You don't have permission to do that. ${error.message}"
    } else {
        ErrorText.humanize(error)
    }

/** One transient message from a ViewModel, shown as a toast. */
data class Notice(val text: String, val tone: Tone)

/**
 * A ViewModel that reports action results as toasts (iOS `.toast(notice)` / `moreErrorAlert`):
 * [notify] and [fail] queue a [Notice]; the screen shows them with [CollectNotices].
 */
abstract class NoticeViewModel : ViewModel() {
    private val _notices = Channel<Notice>(Channel.BUFFERED)

    /** Toasts to show, in order; collect once from the screen. */
    val notices: Flow<Notice> = _notices.receiveAsFlow()

    protected fun notify(text: String, tone: Tone = Tone.SUCCESS) {
        _notices.trySend(Notice(text, tone))
    }

    protected fun fail(error: Throwable) = notify(moreErrorText(error), Tone.DANGER)

    protected fun fail(text: String) = notify(text, Tone.DANGER)
}

/** Shows [notices] with the app's toaster while the screen is composed. */
@Composable
fun CollectNotices(notices: Flow<Notice>) {
    val toaster = LocalToaster.current
    LaunchedEffect(notices, toaster) {
        notices.collect { toaster.toast(it.text, it.tone) }
    }
}

// endregion

// region Scaffold

/**
 * The frame of every pushed More screen: a top app bar with a back button (pops the tab's stack,
 * test tag `back`) and [actions], then [content] on the grouped page.
 */
@Composable
fun MoreScaffold(
    title: String,
    modifier: Modifier = Modifier,
    onBack: (() -> Unit)? = LocalNavigator.current.let { navigator -> { navigator.pop() } },
    actions: @Composable RowScope.() -> Unit = {},
    floatingActionButton: @Composable () -> Unit = {},
    content: @Composable (PaddingValues) -> Unit,
) {
    Scaffold(
        modifier = modifier,
        topBar = {
            TopAppBar(
                title = { Text(title, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                navigationIcon = {
                    if (onBack != null) {
                        IconButton(onClick = onBack, modifier = Modifier.testTag("back")) {
                            Icon(Icons.AutoMirrored.Filled.ArrowBack, contentDescription = "Back")
                        }
                    }
                },
                actions = actions,
            )
        },
        floatingActionButton = floatingActionButton,
        content = content,
    )
}

/** Space after the last section so content clears the gesture bar and a FAB. */
fun LazyListScope.bottomSpacer(height: androidx.compose.ui.unit.Dp = 32.dp) {
    item(key = "bottom-spacer") { Spacer(Modifier.height(height)) }
}

/** A [GroupedSection] as one lazy item. */
fun LazyListScope.groupedItem(
    key: String,
    header: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    item(key = key) { GroupedSection(header = header, footer = footer, content = content) }
}

// endregion

// region Rows

/**
 * A settings row on a grouped card (iOS `NavigationLink { … } label: { Label(…) }`): a leading
 * [icon], a [title] and optional [subtitle], a trailing [value] (secondary) and/or
 * [trailingContent], and a chevron when [onClick] navigates ([chevron]). [tint] colours the title
 * and icon (red for destructive actions); [iconTint] colours only the icon (a status symbol).
 */
@Composable
fun SettingsRow(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector? = null,
    subtitle: String? = null,
    value: String? = null,
    tint: Color? = null,
    iconTint: Color? = null,
    chevron: Boolean = true,
    enabled: Boolean = true,
    busy: Boolean = false,
    onClick: (() -> Unit)? = null,
    trailingContent: (@Composable RowScope.() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    val clickable = if (onClick != null && enabled && !busy) {
        Modifier.clickable(role = Role.Button, onClick = onClick)
    } else {
        Modifier
    }
    val contentAlpha = if (enabled) 1f else 0.38f
    ListItem(
        modifier = modifier.fillMaxWidth().then(clickable),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        leadingContent = icon?.let {
            {
                Icon(
                    it,
                    contentDescription = null,
                    tint = (iconTint ?: tint ?: colors.secondaryLabel).copy(alpha = contentAlpha),
                    modifier = Modifier.size(22.dp),
                )
            }
        },
        headlineContent = {
            Text(
                title,
                style = OptioTheme.type.body,
                color = (tint ?: colors.label).copy(alpha = contentAlpha),
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        },
        supportingContent = subtitle?.let {
            { Text(it, style = OptioTheme.type.footnote, color = colors.secondaryLabel) }
        },
        trailingContent = if (value != null || trailingContent != null || busy || (onClick != null && chevron)) {
            {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.xs)) {
                    if (value != null) {
                        Text(
                            value,
                            style = OptioTheme.type.body,
                            color = colors.secondaryLabel,
                            maxLines = 1,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.padding(start = Spacing.s).widthIn(max = 200.dp),
                        )
                    }
                    trailingContent?.invoke(this)
                    if (busy) {
                        CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp)
                    } else if (onClick != null && chevron) {
                        Icon(
                            Icons.AutoMirrored.Filled.KeyboardArrowRight,
                            contentDescription = null,
                            tint = colors.tertiaryLabel,
                            modifier = Modifier.size(20.dp),
                        )
                    }
                }
            }
        } else {
            null
        },
    )
}

/**
 * A switch row (iOS `Toggle` in a `Form`): [title], an optional caption, the switch at the end;
 * the whole row toggles.
 */
@Composable
fun SwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    enabled: Boolean = true,
    mono: Boolean = false,
) {
    val colors = OptioTheme.colors
    ListItem(
        modifier = modifier
            .fillMaxWidth()
            .then(if (enabled) Modifier.toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange) else Modifier),
        colors = ListItemDefaults.colors(containerColor = Color.Transparent),
        headlineContent = {
            Text(
                title,
                style = if (mono) OptioTheme.type.monoFootnote else OptioTheme.type.body,
                color = colors.label.copy(alpha = if (enabled) 1f else 0.38f),
            )
        },
        supportingContent = subtitle?.let { { Text(it, style = OptioTheme.type.caption, color = colors.secondaryLabel) } },
        trailingContent = { Switch(checked = checked, onCheckedChange = null, enabled = enabled) },
    )
}

/** Wrapping chips for tags such as webhook events or tool names (iOS `MoreChipCloud`). */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ChipCloud(
    items: List<String>,
    modifier: Modifier = Modifier,
) {
    FlowRow(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalArrangement = Arrangement.spacedBy(6.dp),
    ) {
        items.forEach { item ->
            Text(
                item,
                style = OptioTheme.type.caption2.mono(),
                color = OptioTheme.colors.label,
                modifier = Modifier
                    .background(OptioTheme.colors.fillTertiary, Radius.capsuleShape)
                    .padding(horizontal = 8.dp, vertical = 4.dp),
            )
        }
    }
}

/** Footnote text inside a card (explanations, "No devices registered."). */
@Composable
fun CardNote(
    text: String,
    modifier: Modifier = Modifier,
    color: Color = OptioTheme.colors.secondaryLabel,
) {
    Text(
        text,
        style = OptioTheme.type.footnote,
        color = color,
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
    )
}

// endregion

// region States

/**
 * The graceful state for user-scoped routes on a server with authentication disabled
 * (`OPTIO_AUTH_DISABLED=true`): workspaces, access tokens and notification preferences answer 401
 * there because the synthetic dev user has no account.
 */
@Composable
fun AuthDisabledState(
    what: String,
    modifier: Modifier = Modifier,
) {
    EmptyState(
        title = "Not available on this server",
        icon = Icons.Outlined.CloudOff,
        message = "This server runs with authentication disabled, so there are no $what. Sign in to a server with accounts to manage them.",
        modifier = modifier.testTag("auth-disabled"),
    )
}

/** A 403 from a members-only route for a viewer (the member counterpart of `AdminOnlyState`). */
@Composable
fun MembersOnlyState(
    what: String,
    modifier: Modifier = Modifier,
) {
    EmptyState(
        title = "Members only",
        icon = Icons.Outlined.Lock,
        message = "$what are only available to workspace members and admins.",
        modifier = modifier.testTag("members-only"),
    )
}

/** True when [error] is the 401 an auth-disabled server answers on user-scoped routes. */
fun isAuthDisabledRejection(
    error: Throwable?,
    authDisabled: Boolean,
): Boolean = authDisabled && error is ApiError && error.isUnauthorized

// endregion

// region Constants mirrored from the web UI

/** Agent runtimes (iOS `MoreAgentTypes`). */
object MoreAgentTypes {
    val all: List<Pair<String, String>> = listOf(
        "claude-code" to "Claude Code",
        "codex" to "OpenAI Codex",
        "copilot" to "GitHub Copilot",
        "gemini" to "Google Gemini",
        "opencode" to "OpenCode",
        "cursor" to "Cursor",
    )

    fun label(value: String): String = all.firstOrNull { it.first == value }?.second ?: value
}

/** Events an outbound webhook can subscribe to (iOS `MoreWebhookEvents`, the API's enum). */
object MoreWebhookEvents {
    val groups: List<Pair<String, List<String>>> = listOf(
        "Tasks" to listOf("task.completed", "task.failed", "task.needs_attention", "task.pr_opened", "review.completed"),
        "Workflow runs" to listOf("workflow_run.queued", "workflow_run.started", "workflow_run.completed", "workflow_run.failed"),
    )

    val all: List<String> = groups.flatMap { it.second }
}

// endregion
