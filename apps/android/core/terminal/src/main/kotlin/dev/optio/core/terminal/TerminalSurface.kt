package dev.optio.core.terminal

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.isSystemInDarkTheme
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.clipToBounds
import androidx.compose.ui.draw.shadow
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView

/** Defaults for [TerminalSurface]. */
object TerminalDefaults {
    /** The font the grid is ours at (iOS: 12 pt). */
    val FontSize: Dp = TerminalSizing.BASE_FONT_DP.dp

    /** A little air between the grid and the screen edges. */
    val ContentPadding: PaddingValues = PaddingValues(horizontal = 4.dp, vertical = 2.dp)

    /** Test tag (and uiautomator resource-id) of the terminal view. */
    const val VIEW_TEST_TAG: String = "terminal-view"

    /** Test tag of the jump-to-bottom button. */
    const val JUMP_TO_BOTTOM_TEST_TAG: String = "terminal-jump-to-bottom"
}

/**
 * Shows [state] in an [OptioTerminalView], themed with [TerminalTheme] (the canvas fills the whole
 * surface). While the user is scrolled up in the scrollback a small button jumps back to the live
 * bottom. Put a [TerminalKeyBar] under it and apply `imePadding()` to the column so both sit above
 * the keyboard; the terminal refits (Fit) or rescales (Fixed) as the space changes.
 *
 * @param inputMode how the soft keyboard talks to the terminal.
 * @param fontSize the font the grid is ours at; Fixed grids scale from it.
 * @param arrowKeysScrollAltScreen a drag on an alternate screen without mouse tracking sends arrow
 *   keys (see [OptioTerminalView.arrowKeysScrollAltScreen]).
 * @param readOnly nothing can be typed (an exited terminal, a viewer): see [OptioTerminalView.readOnly].
 */
@Composable
fun TerminalSurface(
    state: TerminalState,
    modifier: Modifier = Modifier,
    dark: Boolean = isSystemInDarkTheme(),
    inputMode: TerminalInputMode = TerminalInputMode.Text,
    fontSize: Dp = TerminalDefaults.FontSize,
    contentPadding: PaddingValues = TerminalDefaults.ContentPadding,
    showJumpToBottom: Boolean = true,
    arrowKeysScrollAltScreen: Boolean = true,
    readOnly: Boolean = false,
) {
    val density = LocalDensity.current
    val direction = LocalLayoutDirection.current
    val left = with(density) { contentPadding.calculateLeftPadding(direction).roundToPx() }
    val top = with(density) { contentPadding.calculateTopPadding().roundToPx() }
    val right = with(density) { contentPadding.calculateRightPadding(direction).roundToPx() }
    val bottom = with(density) { contentPadding.calculateBottomPadding().roundToPx() }
    Box(modifier.background(TerminalTheme.background(dark)).clipToBounds()) {
        AndroidView(
            factory = { context -> OptioTerminalView(context) },
            modifier = Modifier.fillMaxSize().testTag(TerminalDefaults.VIEW_TEST_TAG),
            onRelease = { view -> view.state = null },
            update = { view ->
                view.state = state
                view.dark = dark
                view.inputMode = inputMode
                view.fontSizeDp = fontSize.value
                view.arrowKeysScrollAltScreen = arrowKeysScrollAltScreen
                view.readOnly = readOnly
                view.setTerminalPadding(left, top, right, bottom)
            },
        )
        AnimatedVisibility(
            visible = showJumpToBottom && state.scrolledBack,
            modifier = Modifier.align(Alignment.BottomEnd).padding(12.dp),
            enter = fadeIn() + scaleIn(initialScale = 0.8f),
            exit = fadeOut() + scaleOut(targetScale = 0.8f),
        ) {
            JumpToBottomButton(dark = dark, onClick = state::scrollToBottom)
        }
    }
}

@Composable
private fun JumpToBottomButton(dark: Boolean, onClick: () -> Unit) {
    Box(
        modifier =
            Modifier
                .size(40.dp)
                .shadow(elevation = 3.dp, shape = CircleShape)
                .clip(CircleShape)
                .background(Color(TerminalTheme.keyCapArgb(dark)))
                .clickable(onClickLabel = "Jump to bottom", role = Role.Button, onClick = onClick)
                .testTag(TerminalDefaults.JUMP_TO_BOTTOM_TEST_TAG),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = TerminalIcons.JumpToBottom,
            contentDescription = "Jump to bottom",
            tint = TerminalTheme.foreground(dark),
            modifier = Modifier.size(20.dp),
        )
    }
}
