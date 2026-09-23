package dev.optio.core.terminal

import android.view.KeyEvent
import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.ScrollState
import androidx.compose.foundation.background
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.defaultMinSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.isImeVisible
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Immutable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawWithContent
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp

/** One key of [TerminalKeyBar]: what it shows and what it sends. */
@Immutable
data class TerminalKeyBarKey(
    val id: String,
    val label: String,
    val key: TerminalKey,
    val icon: ImageVector? = null,
    val contentDescription: String = label,
) {
    companion object {
        val Esc = TerminalKeyBarKey("esc", "esc", TerminalKey.Special(KeyEvent.KEYCODE_ESCAPE), contentDescription = "Escape")
        val Tab = TerminalKeyBarKey("tab", "tab", TerminalKey.Special(KeyEvent.KEYCODE_TAB), TerminalIcons.Tab, "Tab")
        val CtrlC = TerminalKeyBarKey("ctrl-c", "^C", TerminalKey.Bytes(byteArrayOf(0x03)), contentDescription = "Control C")
        val CtrlD = TerminalKeyBarKey("ctrl-d", "^D", TerminalKey.Bytes(byteArrayOf(0x04)), contentDescription = "Control D")
        val Pipe = TerminalKeyBarKey("pipe", "|", TerminalKey.Char('|'.code), contentDescription = "Pipe")
        val Tilde = TerminalKeyBarKey("tilde", "~", TerminalKey.Char('~'.code), contentDescription = "Tilde")
        val Dash = TerminalKeyBarKey("dash", "-", TerminalKey.Char('-'.code), contentDescription = "Dash")
        val Slash = TerminalKeyBarKey("slash", "/", TerminalKey.Char('/'.code), contentDescription = "Slash")
        val Up = TerminalKeyBarKey("up", "↑", TerminalKey.Special(KeyEvent.KEYCODE_DPAD_UP), TerminalIcons.ArrowUp, "Up")
        val Down = TerminalKeyBarKey("down", "↓", TerminalKey.Special(KeyEvent.KEYCODE_DPAD_DOWN), TerminalIcons.ArrowDown, "Down")
        val Right = TerminalKeyBarKey("right", "→", TerminalKey.Special(KeyEvent.KEYCODE_DPAD_RIGHT), TerminalIcons.ArrowRight, "Right")
        val Left = TerminalKeyBarKey("left", "←", TerminalKey.Special(KeyEvent.KEYCODE_DPAD_LEFT), TerminalIcons.ArrowLeft, "Left")

        /** iOS's keys: esc, tab, ^C, ^D and the symbols a phone keyboard buries. */
        val Defaults: List<TerminalKeyBarKey> = listOf(Esc, Tab, CtrlC, CtrlD, Pipe, Tilde, Dash, Slash)

        /** The arrows, in iOS's order (up, down, right, left). */
        val Arrows: List<TerminalKeyBarKey> = listOf(Up, Down, Right, Left)

        /** The Ctrl menu (long-press "ctrl"), as on iOS. */
        val CtrlMenu: List<Pair<String, Byte>> =
            listOf(
                "C" to 0x03, "D" to 0x04, "Z" to 0x1a, "L" to 0x0c, "R" to 0x12,
                "A" to 0x01, "E" to 0x05, "U" to 0x15, "K" to 0x0b, "W" to 0x17,
            ).map { (label, code) -> label to code.toByte() }
    }
}

/**
 * The extra-keys bar for terminals (Local and pod sessions): a port of iOS `TerminalKeyBar.swift`.
 * Keys a phone keyboard lacks (esc, tab, ^C, ^D, `|` `~` `-` `/`, arrows that follow the program's
 * cursor-key mode), sticky **ctrl** and **alt** (tap: the next key, from the bar or the keyboard,
 * gets the modifier; long-press ctrl: iOS's Ctrl+… menu), and a keyboard toggle. Every key goes
 * through [TerminalState.sendKey], so it counts as an interaction (a Local viewer claims the grid
 * before the key lands) and its bytes reach [TerminalState.onInput]. Scrolls sideways when the keys
 * don't fit; a light haptic on each press.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun TerminalKeyBar(
    state: TerminalState,
    modifier: Modifier = Modifier,
    keys: List<TerminalKeyBarKey> = TerminalKeyBarKey.Defaults,
    enabled: Boolean = true,
    showArrows: Boolean = true,
    showKeyboardToggle: Boolean = true,
    dark: Boolean = isSystemInDarkTheme(),
) {
    val haptics = LocalHapticFeedback.current
    val imeVisible = WindowInsets.isImeVisible
    val keyboardShown = state.isFocused && imeVisible
    val press: (() -> Unit) -> Unit = { action ->
        haptics.performHapticFeedback(HapticFeedbackType.KeyboardTap)
        action()
    }
    Row(
        modifier =
            modifier
                .fillMaxWidth()
                .background(Color(TerminalTheme.keyBarArgb(dark)))
                .padding(vertical = 6.dp)
                .alpha(if (enabled) 1f else 0.5f)
                .testTag("terminal-key-bar"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        val scroll = rememberScrollState()
        Row(
            modifier =
                Modifier
                    .weight(1f)
                    .fadingEdges(scroll, Color(TerminalTheme.keyBarArgb(dark)))
                    .horizontalScroll(scroll)
                    .padding(horizontal = 8.dp),
            horizontalArrangement = Arrangement.spacedBy(6.dp),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            CtrlKey(state, enabled, dark, press)
            KeyCap(
                id = "alt",
                label = "alt",
                contentDescription = "Alt",
                dark = dark,
                enabled = enabled,
                latched = state.altLatched,
                onClick = { press { state.altLatched = !state.altLatched } },
            )
            val all = if (showArrows) keys + TerminalKeyBarKey.Arrows else keys
            all.forEach { key ->
                KeyCap(
                    id = key.id,
                    label = key.label,
                    icon = key.icon,
                    contentDescription = key.contentDescription,
                    dark = dark,
                    enabled = enabled,
                    onClick = { press { state.sendKey(key.key) } },
                )
            }
        }
        if (showKeyboardToggle) {
            KeyCap(
                id = "keyboard",
                icon = if (keyboardShown) TerminalIcons.KeyboardHide else TerminalIcons.Keyboard,
                contentDescription = if (keyboardShown) "Hide keyboard" else "Show keyboard",
                dark = dark,
                enabled = true,
                modifier = Modifier.padding(end = 8.dp),
                onClick = { press { if (keyboardShown) state.blur() else state.focus() } },
            )
        }
    }
}

@Composable
private fun CtrlKey(state: TerminalState, enabled: Boolean, dark: Boolean, press: (() -> Unit) -> Unit) {
    var menuOpen by remember { mutableStateOf(false) }
    Box {
        KeyCap(
            id = "ctrl",
            label = "ctrl",
            contentDescription = "Control",
            dark = dark,
            enabled = enabled,
            latched = state.ctrlLatched,
            onClick = { press { state.ctrlLatched = !state.ctrlLatched } },
            onLongClick = { press { menuOpen = true } },
        )
        DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
            TerminalKeyBarKey.CtrlMenu.forEach { (label, code) ->
                DropdownMenuItem(
                    text = { Text("Ctrl+$label", fontFamily = TerminalFonts.fontFamily) },
                    onClick = {
                        menuOpen = false
                        state.sendKey(TerminalKey.Bytes(byteArrayOf(code)))
                    },
                    modifier = Modifier.testTag("terminal-key-ctrl-$label"),
                )
            }
        }
    }
}

/** Fades keys into the bar where the row scrolls on, so a clipped key reads as "more this way". */
private fun Modifier.fadingEdges(scroll: ScrollState, color: Color): Modifier =
    drawWithContent {
        drawContent()
        val fade = 20.dp.toPx().coerceAtMost(size.width / 4)
        if (scroll.value > 0) {
            drawRect(
                brush = Brush.horizontalGradient(listOf(color, color.copy(alpha = 0f)), startX = 0f, endX = fade),
                size = Size(fade, size.height),
            )
        }
        if (scroll.value < scroll.maxValue) {
            drawRect(
                brush = Brush.horizontalGradient(listOf(color.copy(alpha = 0f), color), startX = size.width - fade, endX = size.width),
                topLeft = Offset(size.width - fade, 0f),
                size = Size(fade, size.height),
            )
        }
    }

@OptIn(ExperimentalFoundationApi::class)
@Composable
private fun KeyCap(
    id: String,
    contentDescription: String,
    dark: Boolean,
    enabled: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    label: String? = null,
    icon: ImageVector? = null,
    latched: Boolean = false,
    onLongClick: (() -> Unit)? = null,
) {
    val interaction = remember { MutableInteractionSource() }
    val pressed by interaction.collectIsPressedAsState()
    val fg = TerminalTheme.foreground(dark)
    val background =
        when {
            latched -> fg
            pressed -> Color(TerminalTheme.keyCapPressedArgb(dark))
            else -> Color(TerminalTheme.keyCapArgb(dark))
        }
    val content = if (latched) TerminalTheme.background(dark) else fg
    Box(
        modifier =
            modifier
                .height(34.dp)
                .defaultMinSize(minWidth = 40.dp)
                .clip(RoundedCornerShape(8.dp))
                .background(background)
                .combinedClickable(
                    interactionSource = interaction,
                    indication = null,
                    enabled = enabled,
                    role = Role.Button,
                    onLongClick = onLongClick,
                    onClick = onClick,
                )
                .semantics {
                    this.contentDescription = contentDescription
                    if (latched) selected = true
                }
                .testTag("terminal-key-$id")
                .padding(horizontal = 9.dp),
        contentAlignment = Alignment.Center,
    ) {
        if (icon != null) {
            Icon(imageVector = icon, contentDescription = null, tint = content, modifier = Modifier.size(18.dp))
        } else if (label != null) {
            Text(text = label, color = content, fontFamily = TerminalFonts.fontFamily, fontWeight = FontWeight.Medium, fontSize = 13.sp)
        }
    }
}
