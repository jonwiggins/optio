package dev.optio.core.terminal

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The handful of icons the key bar and the jump-to-bottom button need, as vectors (path data from
 * Material Icons, Apache 2.0) so this module needs no icon library.
 */
internal object TerminalIcons {
    val ArrowUp: ImageVector by lazy { icon("ArrowUp", "M4,12l1.41,1.41L11,7.83V20h2V7.83l5.58,5.59L20,12l-8,-8 -8,8z") }
    val ArrowDown: ImageVector by lazy { icon("ArrowDown", "M20,12l-1.41,-1.41L13,16.17V4h-2v12.17l-5.58,-5.59L4,12l8,8 8,-8z") }
    val ArrowLeft: ImageVector by lazy { icon("ArrowLeft", "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z") }
    val ArrowRight: ImageVector by lazy { icon("ArrowRight", "M12,4l-1.41,1.41L16.17,11H4v2h12.17l-5.58,5.59L12,20l8,-8z") }
    val Tab: ImageVector by lazy {
        icon("Tab", "M11.59,7.41L15.17,11H1v2h14.17l-3.59,3.59L13,18l6,-6 -6,-6 -1.41,1.41zM20,6v12h2V6h-2z")
    }
    val Keyboard: ImageVector by lazy {
        icon(
            "Keyboard",
            "M20,5H4c-1.1,0 -1.99,0.9 -1.99,2L2,17c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V7c0,-1.1 -0.9,-2 -2,-2zM11,8h2v2h-2V8zM11,11h2v2h-2v-2zM8,8h2v2H8V8zM8,11h2v2H8v-2zM7,13H5v-2h2v2zM7,10H5V8h2v2zM16,17H8v-2h8v2zM16,13h-2v-2h2v2zM16,10h-2V8h2v2zM19,13h-2v-2h2v2zM19,10h-2V8h2v2z",
        )
    }
    val KeyboardHide: ImageVector by lazy {
        icon(
            "KeyboardHide",
            "M20,3H4c-1.1,0 -1.99,0.9 -1.99,2L2,15c0,1.1 0.9,2 2,2h16c1.1,0 2,-0.9 2,-2V5c0,-1.1 -0.9,-2 -2,-2zM11,6h2v2h-2V6zM11,9h2v2h-2V9zM8,6h2v2H8V6zM8,9h2v2H8V9zM7,11H5V9h2v2zM7,8H5V6h2v2zM16,15H8v-2h8v2zM16,11h-2V9h2v2zM16,8h-2V6h2v2zM19,11h-2V9h2v2zM19,8h-2V6h2v2zM12,23l4,-4H8l4,4z",
        )
    }
    val JumpToBottom: ImageVector by lazy { icon("JumpToBottom", "M16,13h-3V3h-2v10H8l4,4 4,-4zM4,19v2h16v-2H4z") }

    private fun icon(name: String, pathData: String): ImageVector =
        ImageVector.Builder(name = name, defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .addPath(pathData = addPathNodes(pathData), fill = SolidColor(Color.Black))
            .build()
}
