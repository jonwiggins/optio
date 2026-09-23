package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.outlined.ErrorOutline
import androidx.compose.material.icons.outlined.Inbox
import androidx.compose.material.icons.outlined.Lock
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Icon
import androidx.compose.material3.LocalContentColor
import androidx.compose.material3.ProvideTextStyle
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.state.ErrorText
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.semibold

/**
 * Empty state (iOS `EmptyState` / `ContentUnavailableView`): a light symbol, a title, one sentence,
 * and at most one action when creation is possible. Copy must respect the active filter
 * ("No closed issues"). Centred in the space it is given.
 */
@Composable
fun EmptyState(
    title: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = Icons.Outlined.Inbox,
    message: String? = null,
    actionTitle: String? = null,
    action: (() -> Unit)? = null,
) {
    val colors = OptioTheme.colors
    Column(
        modifier = modifier.fillMaxWidth().padding(horizontal = Spacing.xl, vertical = 40.dp).testTag("empty-state"),
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(icon, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(44.dp))
        Spacer(Modifier.height(Spacing.xs))
        Text(title, style = OptioTheme.type.title3.semibold(), color = colors.label, textAlign = TextAlign.Center)
        if (message != null) {
            Text(
                message,
                style = OptioTheme.type.subheadline,
                color = colors.secondaryLabel,
                textAlign = TextAlign.Center,
                modifier = Modifier.widthIn(max = 320.dp),
            )
        }
        if (actionTitle != null && action != null) {
            Spacer(Modifier.height(Spacing.s))
            Button(onClick = action, modifier = Modifier.testTag("empty-state-action")) { Text(actionTitle) }
        }
    }
}

/** Friendly state for admin-only endpoints that answered 403 (iOS `AdminOnlyState`). */
@Composable
fun AdminOnlyState(
    modifier: Modifier = Modifier,
    what: String = "This section",
) {
    EmptyState(
        title = "Admins only",
        icon = Icons.Outlined.Lock,
        message = "$what is only available to workspace admins.",
        modifier = modifier,
    )
}

object ErrorRowDefaults {
    val ContentPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.s)
}

/**
 * One-line inline error with a Retry text button (iOS `ErrorRow`): red only on the symbol, the
 * copy humanised through [ErrorText.humanize]. Action failures use a toast instead.
 */
@Composable
fun ErrorRow(
    error: Throwable,
    modifier: Modifier = Modifier,
    what: String? = null,
    retry: (() -> Unit)? = null,
    contentPadding: PaddingValues = ErrorRowDefaults.ContentPadding,
) {
    ErrorRow(message = ErrorText.humanize(error, what), modifier = modifier, retry = retry, contentPadding = contentPadding)
}

/** [ErrorRow] with ready-made copy. */
@Composable
fun ErrorRow(
    message: String,
    modifier: Modifier = Modifier,
    retry: (() -> Unit)? = null,
    contentPadding: PaddingValues = ErrorRowDefaults.ContentPadding,
) {
    val colors = OptioTheme.colors
    Row(
        modifier = modifier.fillMaxWidth().padding(contentPadding).testTag("error-row"),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Icon(Icons.Outlined.ErrorOutline, contentDescription = null, tint = colors.red, modifier = Modifier.size(18.dp))
        Text(message, style = OptioTheme.type.footnote, color = colors.secondaryLabel, modifier = Modifier.weight(1f))
        if (retry != null) {
            TextButton(
                onClick = retry,
                contentPadding = ButtonDefaults.TextButtonWithIconContentPadding,
                modifier = Modifier.testTag("retry"),
            ) {
                Text("Retry", style = OptioTheme.type.footnote.semibold())
            }
        }
    }
}

/**
 * A notice with a 3dp leading tone bar (iOS `NoticeBanner`), replacing stroked or tinted notice
 * cards: token expiry, stalls, plan-ready. [content] is set in footnote, secondary.
 */
@Composable
fun NoticeBanner(
    modifier: Modifier = Modifier,
    tone: Tone = Tone.ACCENT,
    icon: ImageVector? = null,
    title: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = OptioTheme.colors
    Row(
        modifier = modifier
            .fillMaxWidth()
            .cardSurface()
            .height(IntrinsicSize.Min)
            .padding(vertical = 2.dp),
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Box(
            Modifier
                .fillMaxHeight()
                .width(3.dp)
                .background(tone.color, Radius.capsuleShape),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            if (title != null) {
                Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(6.dp)) {
                    if (icon != null) Icon(icon, contentDescription = null, tint = tone.textColor, modifier = Modifier.size(18.dp))
                    Text(title, style = OptioTheme.type.subheadline.semibold(), color = colors.label)
                }
            }
            CompositionLocalProvider(LocalContentColor provides colors.secondaryLabel) {
                ProvideTextStyle(OptioTheme.type.footnote) {
                    content()
                }
            }
        }
    }
}
