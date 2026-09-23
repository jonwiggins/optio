package dev.optio.core.ui.components

import android.content.ClipData
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.text.selection.SelectionContainer
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.ClipEntry
import androidx.compose.ui.platform.LocalClipboard
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.toast.LocalToaster
import kotlinx.coroutines.launch

/** Where a single-line [MonoText] cuts a value that doesn't fit. */
enum class Truncation(internal val overflow: TextOverflow) {
    /** `…tail` — paths: the leaf survives (iOS `.truncationMode(.head)`). */
    HEAD(TextOverflow.StartEllipsis),

    /** `start…end` — ids and hashes. */
    MIDDLE(TextOverflow.MiddleEllipsis),

    /** `start…` — everything else. */
    END(TextOverflow.Ellipsis),
}

/**
 * Mono text for things that are names: paths, branches, `#519`, slugs, cron, ids (never prose,
 * status words or cost). Single line by default, truncated per [truncation].
 */
@Composable
fun MonoText(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = OptioTheme.type.monoSubheadline,
    color: Color = OptioTheme.colors.label,
    truncation: Truncation = Truncation.END,
    maxLines: Int = 1,
) {
    Text(
        text,
        style = style,
        color = color,
        maxLines = maxLines,
        softWrap = maxLines > 1,
        overflow = if (maxLines == 1) truncation.overflow else TextOverflow.Ellipsis,
        modifier = modifier,
    )
}

/** Puts [text] on the clipboard (the system shows its own confirmation on Android 13+). */
suspend fun copyToClipboard(clipboard: androidx.compose.ui.platform.Clipboard, text: String, label: String = "Optio") {
    clipboard.setClipEntry(ClipEntry(ClipData.newPlainText(label, text)))
}

/**
 * A value you can copy (ids, URLs, tokens shown once, commands): tap or long-press copies [text]
 * to the clipboard with a haptic tick and a "Copied" toast. Mono by default; [displayText] lets
 * the row show a shortened form while copying the whole value.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun CopyableText(
    text: String,
    modifier: Modifier = Modifier,
    displayText: String = text,
    style: TextStyle = OptioTheme.type.monoFootnote,
    color: Color = OptioTheme.colors.secondaryLabel,
    truncation: Truncation = Truncation.MIDDLE,
    maxLines: Int = 1,
    copiedMessage: String = "Copied",
) {
    val clipboard = LocalClipboard.current
    val toaster = LocalToaster.current
    val haptics = LocalHapticFeedback.current
    val scope = rememberCoroutineScope()
    val copy: () -> Unit = {
        haptics.performHapticFeedback(HapticFeedbackType.LongPress)
        scope.launch {
            copyToClipboard(clipboard, text)
            toaster.success(copiedMessage)
        }
    }
    MonoText(
        text = displayText,
        style = style,
        color = color,
        truncation = truncation,
        maxLines = maxLines,
        modifier = modifier
            .combinedClickable(onClick = copy, onLongClick = copy, onClickLabel = "Copy", role = Role.Button)
            .testTag("copyable"),
    )
}

/**
 * A selectable mono block on the inset fill (JSON, prompts, cron, command lines, tool output).
 * Long lines scroll sideways unless [wrap]. Never nest it inside another fill.
 */
@Composable
fun CodeBlock(
    text: String,
    modifier: Modifier = Modifier,
    style: TextStyle = OptioTheme.type.monoFootnote,
    color: Color = OptioTheme.colors.label,
    wrap: Boolean = true,
    padding: Dp = Spacing.s,
    background: Color = OptioTheme.colors.fillTertiary,
) {
    val scroll = if (wrap) Modifier else Modifier.horizontalScroll(rememberScrollState())
    Box(
        modifier
            .fillMaxWidth()
            .background(background, Radius.smallShape)
            .then(scroll)
            .padding(padding),
    ) {
        SelectionContainer {
            Text(text, style = style, color = color, softWrap = wrap)
        }
    }
}
