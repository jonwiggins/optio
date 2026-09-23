package dev.optio.core.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.WindowInsetsSides
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.ime
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.only
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.union
import androidx.compose.foundation.layout.windowInsetsPadding
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.ArrowUpward
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * The message field + send button pinned under a chat or log (iOS `ChatComposer`): a capsule field
 * on a quiet fill that grows to six lines, and an accent circular send button that spins while
 * [onSend] runs. [onSend] receives the trimmed text; the field clears as soon as it is sent.
 * [autofocus] raises the keyboard on first composition (deep links with `compose=1`). Pads itself
 * for the keyboard and navigation bar ([windowInsets]); place it in a Scaffold's `bottomBar`.
 * Test tags: `composer-field`, `composer-send`.
 */
@Composable
fun ChatComposer(
    onSend: suspend (String) -> Unit,
    modifier: Modifier = Modifier,
    placeholder: String = "Message",
    enabled: Boolean = true,
    autofocus: Boolean = false,
    windowInsets: WindowInsets = WindowInsets.ime.union(WindowInsets.navigationBars).only(WindowInsetsSides.Bottom),
) {
    val colors = OptioTheme.colors
    val type = OptioTheme.type
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    var text by rememberSaveable { mutableStateOf("") }
    var sending by remember { mutableStateOf(false) }
    val focus = remember { FocusRequester() }
    val canSend = enabled && !sending && text.isNotBlank()

    LaunchedEffect(autofocus) { if (autofocus) runCatching { focus.requestFocus() } }

    fun send() {
        val message = text.trim()
        if (message.isEmpty() || sending) return
        haptics.performHapticFeedback(HapticFeedbackType.Confirm)
        sending = true
        text = ""
        scope.launch {
            try {
                onSend(message)
            } finally {
                sending = false
            }
        }
    }

    Box(modifier.fillMaxWidth().background(MaterialTheme.colorScheme.surfaceContainer)) {
        HorizontalDivider(thickness = Dp.Hairline, color = colors.separator)
        Row(
            modifier = Modifier
                .fillMaxWidth()
                .windowInsetsPadding(windowInsets)
                .padding(horizontal = Spacing.l, vertical = Spacing.s),
            verticalAlignment = Alignment.Bottom,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            BasicTextField(
                value = text,
                onValueChange = { text = it },
                enabled = enabled,
                textStyle = type.body.copy(color = colors.label),
                cursorBrush = SolidColor(colors.accent),
                keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
                maxLines = 6,
                modifier = Modifier
                    .weight(1f)
                    .focusRequester(focus)
                    .testTag("composer-field"),
                decorationBox = { inner ->
                    Box(
                        Modifier
                            .fillMaxWidth()
                            .background(colors.fillTertiary, Radius.bubbleShape)
                            .padding(horizontal = 14.dp, vertical = 9.dp),
                    ) {
                        if (text.isEmpty()) Text(placeholder, style = type.body, color = colors.tertiaryLabel)
                        inner()
                    }
                },
            )
            IconButton(
                onClick = ::send,
                enabled = canSend,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                    disabledContainerColor = colors.tertiaryLabel,
                    disabledContentColor = colors.page,
                ),
                shape = CircleShape,
                modifier = Modifier.size(40.dp).testTag("composer-send"),
            ) {
                if (sending) {
                    CircularProgressIndicator(Modifier.size(18.dp), strokeWidth = 2.dp, color = MaterialTheme.colorScheme.onPrimary)
                } else {
                    Icon(Icons.Filled.ArrowUpward, contentDescription = "Send", modifier = Modifier.size(20.dp))
                }
            }
        }
    }
}
