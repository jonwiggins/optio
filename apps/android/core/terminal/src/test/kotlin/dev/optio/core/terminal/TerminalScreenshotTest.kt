package dev.optio.core.terminal

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.junit4.v2.createComposeRule
import androidx.compose.ui.test.onRoot
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import com.github.takahirom.roborazzi.captureRoboImage
import org.junit.Rule
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * [TerminalSurface] + [TerminalKeyBar] on a phone, light and dark, playing [TerminalSamples].
 * `./gradlew :core:terminal:recordRoborazziDebug` writes the PNGs to `build/outputs/roborazzi/`.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
class TerminalScreenshotTest {
    @get:Rule
    val compose = createComposeRule()

    private fun capture(
        name: String,
        mode: TerminalGridMode = TerminalGridMode.Fit,
        before: (TerminalState) -> Unit = {},
        after: (TerminalState) -> Unit = {},
        sample: (TerminalGrid) -> String,
    ) {
        var dark by mutableStateOf(false)
        var terminal by mutableStateOf(TerminalState(mode))
        compose.setContent {
            key(terminal) {
                Column(Modifier.fillMaxSize().background(TerminalTheme.background(dark))) {
                    TerminalSurface(terminal, Modifier.weight(1f), dark = dark)
                    TerminalKeyBar(terminal, dark = dark)
                }
            }
        }
        for (theme in listOf(false, true)) {
            val state = TerminalState(mode).also(before)
            compose.runOnIdle {
                dark = theme
                terminal = state
            }
            compose.waitForIdle()
            state.feed(sample(state.grid))
            after(state)
            compose.waitForIdle()
            compose.onRoot().captureRoboImage("build/outputs/roborazzi/Terminal_${name}_${if (theme) "dark" else "light"}.png")
        }
    }

    @Test
    fun colours() = capture("colours") { TerminalSamples.colors() }

    @Test
    fun unicode() = capture("unicode") { TerminalSamples.unicode() }

    @Test
    fun shellScrolledBackWithASelection() =
        capture(
            "shell",
            before = { it.ctrlLatched = true },
            after = { state ->
                state.scrollBy(-12)
                val row = state.topRow + 3
                state.select(2, row, 10, row + 1)
            },
        ) { TerminalSamples.shell() }

    @Test
    fun claudeLikeTuiFittedToThePhone() = capture("claude") { TerminalSamples.claudeCode(it.cols, it.rows) }

    @Test
    fun laptopGridShrunkToFit() =
        // "Sized for another device": a 160×45 laptop session, clamped at the minimum font; it pans.
        capture("laptop_160x45", mode = TerminalGridMode.Fixed(160, 45)) { TerminalSamples.claudeCode(it.cols, it.rows) }

    @Test
    fun wideGridScaledToWidth() = capture("fixed_80x24", mode = TerminalGridMode.Fixed(80, 24)) { TerminalSamples.altScreen(it.cols, it.rows) }

    @Test
    fun altScreenRedraw() = capture("htop") { TerminalSamples.altScreen(it.cols, it.rows, frame = 3) }
}
