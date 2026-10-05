package dev.optio.core.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.PathFillType
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme

/** Optio's own icons. */
object OptioIcons {
    /** Peek, the O-shaped face shared with the app icon and iOS BotGlyph. */
    val Bot: ImageVector by lazy {
        ImageVector.Builder(name = "OptioPeek", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 100f, viewportHeight = 100f)
            .apply {
                optioMarkPaths.forEach { data ->
                    addPath(
                        pathData = addPathNodes(data),
                        pathFillType = PathFillType.EvenOdd,
                        fill = SolidColor(Color.Black),
                    )
                }
            }
            .build()
    }
}

/** The bot glyph at a size, in a colour (iOS `OptioGlyph`). Decorative. */
@Composable
fun OptioGlyph(
    modifier: Modifier = Modifier,
    size: Dp = 16.dp,
    color: Color = OptioTheme.colors.secondaryLabel,
) {
    Icon(OptioIcons.Bot, contentDescription = null, tint = color, modifier = modifier.size(size))
}
