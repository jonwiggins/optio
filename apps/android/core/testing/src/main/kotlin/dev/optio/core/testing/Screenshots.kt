package dev.optio.core.testing

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.ui.Modifier
import androidx.compose.ui.test.ComposeUiTest
import androidx.compose.ui.test.ExperimentalTestApi
import androidx.compose.ui.test.SemanticsNodeInteractionsProvider
import androidx.compose.ui.test.onRoot
import androidx.compose.ui.unit.Density
import androidx.compose.ui.test.v2.runComposeUiTest
import com.github.takahirom.roborazzi.captureRoboImage
import com.github.takahirom.roborazzi.captureScreenRoboImage
import dev.optio.core.ui.format.LocalClock
import dev.optio.core.ui.theme.OptioTheme
import java.time.Clock
import org.robolectric.RuntimeEnvironment

/** Where screenshots land (relative to the module), as `recordRoborazziDebug` expects. */
const val SCREENSHOT_DIR = "build/outputs/roborazzi"

/** Light and dark, in that order; [captureScreens] renders each. */
enum class ThemeMode(val suffix: String, internal val qualifier: String, val dark: Boolean) {
    LIGHT("light", "+notnight", false),
    DARK("dark", "+night", true),
}

/** Device sizes for screenshots. [TALL] fits a long gallery or list on one image. */
enum class ScreenSize(val widthDp: Int, val heightDp: Int) {
    /** Pixel 7 (412 × 915 dp, 420 dpi). */
    PHONE(412, 915),

    /** A phone-width canvas twice as tall, for long lists and galleries. */
    TALL(412, 1830),

    /** A small tablet / unfolded foldable in landscape (NavigationRail layouts). */
    TABLET(1024, 768),
    ;

    internal val qualifiers: String
        get() = "w${widthDp}dp-h${heightDp}dp-normal-long-notround-any-420dpi-keyshidden-nonav"
}

/**
 * Renders [content] inside [OptioTheme] once per [modes] (light and dark by default) on a [size]
 * canvas and records `build/outputs/roborazzi/<name>_light.png` / `<name>_dark.png`. Files are
 * written only by `./gradlew :<module>:recordRoborazziDebug`; `testDebugUnitTest` runs the same
 * code without writing (a cheap "does it compose" check).
 *
 * - The canvas is the grouped page colour, so cards read as they do in the app.
 * - Relative times are frozen: `LocalClock` is [clock] ([Samples.clock], 2026-09-22 16:40 UTC).
 * - [interact] runs after the first frame (click, scroll, type) before the capture.
 * - [wholeScreen] captures every window (dialogs, bottom sheets, menus) instead of the root.
 *
 * Use from a Robolectric test class annotated `@RunWith(AndroidJUnit4::class)` and
 * `@GraphicsMode(GraphicsMode.Mode.NATIVE)` (or extend [ScreenshotTest]) without a
 * `createComposeRule()` rule: each mode runs in its own `runComposeUiTest`.
 *
 * ```
 * @Test fun jobRow() = captureScreens("JobRow") { JobRow(Samples.workflow()) }
 * ```
 */
@OptIn(ExperimentalTestApi::class)
fun captureScreens(
    name: String,
    size: ScreenSize = ScreenSize.PHONE,
    modes: List<ThemeMode> = ThemeMode.entries,
    clock: Clock = Samples.clock,
    wholeScreen: Boolean = false,
    interact: ScreenScope.() -> Unit = {},
    content: @Composable () -> Unit,
) {
    for (mode in modes) {
        RuntimeEnvironment.setQualifiers(size.qualifiers)
        RuntimeEnvironment.setQualifiers(mode.qualifier)
        runComposeUiTest {
            setContent {
                ScreenshotFrame(dark = mode.dark, clock = clock, content = content)
            }
            ScreenScope(this).interact()
            waitForIdle()
            val path = "$SCREENSHOT_DIR/${name}_${mode.suffix}.png"
            if (wholeScreen) captureScreenRoboImage(path) else onRoot().captureRoboImage(path)
        }
    }
}

/**
 * What [captureScreens]' `interact` block can do before the capture: find nodes (`onNode`,
 * `onNodeWithTag`, `onNodeWithText`, …) and act on them (`performClick`, `performScrollTo`, …),
 * wait for idle, or advance the frame clock (animations).
 */
@OptIn(ExperimentalTestApi::class)
class ScreenScope internal constructor(private val test: ComposeUiTest) : SemanticsNodeInteractionsProvider by test {
    val density: Density
        get() = test.density

    fun waitForIdle() = test.waitForIdle()

    /** Advances the test frame clock by [millis] (runs animations forward). */
    fun advanceTimeBy(millis: Long) = test.mainClock.advanceTimeBy(millis)
}

/**
 * The frame [captureScreens] draws in: [OptioTheme] for [dark], a fixed [clock], and a full-size
 * page-coloured background. Use it directly with `createComposeRule()` tests that capture by hand.
 */
@Composable
fun ScreenshotFrame(
    dark: Boolean,
    clock: Clock = Samples.clock,
    content: @Composable () -> Unit,
) {
    OptioTheme(darkTheme = dark) {
        CompositionLocalProvider(LocalClock provides clock) {
            Box(Modifier.fillMaxSize().background(OptioTheme.colors.page)) {
                content()
            }
        }
    }
}
