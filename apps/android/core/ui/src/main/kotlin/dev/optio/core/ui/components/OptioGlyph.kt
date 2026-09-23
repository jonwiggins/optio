package dev.optio.core.ui.components

import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.path
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme

/** Optio's own icons. */
object OptioIcons {
    /**
     * The Optio bot (iOS `BotGlyph`): antenna, head, ears, eyes — the app icon's mark, stroked on a
     * 24-unit grid so it takes any tint. Use it with `Icon(OptioIcons.Bot, …)` or [OptioGlyph].
     */
    val Bot: ImageVector by lazy {
        ImageVector.Builder(name = "OptioBot", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
            .path(
                fill = null,
                stroke = SolidColor(Color.Black),
                strokeLineWidth = 2.25f,
                strokeLineCap = StrokeCap.Round,
                strokeLineJoin = StrokeJoin.Round,
            ) {
                // antenna
                moveTo(12f, 8f)
                lineTo(12f, 4f)
                lineTo(8f, 4f)
                // head: a 16×12 rounded rect at (4, 8), corner 2.4
                moveTo(6.4f, 8f)
                lineTo(17.6f, 8f)
                arcTo(2.4f, 2.4f, 0f, false, true, 20f, 10.4f)
                lineTo(20f, 17.6f)
                arcTo(2.4f, 2.4f, 0f, false, true, 17.6f, 20f)
                lineTo(6.4f, 20f)
                arcTo(2.4f, 2.4f, 0f, false, true, 4f, 17.6f)
                lineTo(4f, 10.4f)
                arcTo(2.4f, 2.4f, 0f, false, true, 6.4f, 8f)
                close()
                // ears
                moveTo(2f, 14f)
                lineTo(4f, 14f)
                moveTo(20f, 14f)
                lineTo(22f, 14f)
                // eyes
                moveTo(15f, 13f)
                lineTo(15f, 15f)
                moveTo(9f, 13f)
                lineTo(9f, 15f)
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
