package dev.optio.feature.auth

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.graphics.vector.addPathNodes
import androidx.compose.ui.unit.dp

/**
 * The lucide "bot" outline used for the app icon (iOS `BotGlyph`), on the 24-unit lucide grid.
 * Stroked in black; tint it (`Icon(BotGlyph, tint = …)`).
 */
internal val BotGlyph: ImageVector by lazy {
    val paths =
        listOf(
            // antenna
            "M12,8V4H8",
            // head: rect x=4 y=8 w=16 h=12 rx=2.4
            "M6.4,8H17.6A2.4,2.4 0,0 1,20 10.4V17.6A2.4,2.4 0,0 1,17.6 20H6.4A2.4,2.4 0,0 1,4 17.6V10.4A2.4,2.4 0,0 1,6.4 8Z",
            // ears
            "M2,14H4M20,14H22",
            // eyes
            "M15,13V15M9,13V15",
        )
    ImageVector.Builder(name = "BotGlyph", defaultWidth = 24.dp, defaultHeight = 24.dp, viewportWidth = 24f, viewportHeight = 24f)
        .apply {
            paths.forEach { data ->
                addPath(
                    pathData = addPathNodes(data),
                    stroke = SolidColor(Color.Black),
                    strokeLineWidth = 2.2f,
                    strokeLineCap = StrokeCap.Round,
                    strokeLineJoin = StrokeJoin.Round,
                )
            }
        }.build()
}
