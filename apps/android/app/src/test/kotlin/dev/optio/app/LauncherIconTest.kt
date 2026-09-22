package dev.optio.app

import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.requiredSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.colorResource
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.dp
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.GraphicsMode

/**
 * Renders the adaptive launcher icon (`./gradlew :app:recordRoborazziDebug`, then open
 * `app/build/outputs/roborazzi/LauncherIcon.png`): the full 108dp canvas with the 66dp safe zone
 * outlined, then the icon as a circular launcher mask shows it.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
class LauncherIconTest {
    @get:Rule
    val compose = createComposeRule()

    @Test
    fun foregroundSitsInsideTheSafeZone() {
        compose.setContent {
            val background = colorResource(R.color.ic_launcher_background)
            val foreground = painterResource(R.drawable.ic_launcher_foreground)
            Row(Modifier.background(Color.White).padding(16.dp), horizontalArrangement = Arrangement.spacedBy(16.dp)) {
                Box(Modifier.size(108.dp).background(background)) {
                    Image(foreground, contentDescription = null, modifier = Modifier.fillMaxSize())
                    Box(Modifier.align(Alignment.Center).size(66.dp).border(1.dp, Color.Yellow, CircleShape))
                }
                Box(Modifier.size(72.dp).clip(CircleShape).background(background), contentAlignment = Alignment.Center) {
                    Image(foreground, contentDescription = null, modifier = Modifier.requiredSize(108.dp))
                }
            }
        }
        compose.onRoot().captureRoboImage("build/outputs/roborazzi/LauncherIcon.png")
    }
}
