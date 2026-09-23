package dev.optio.core.testing

import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.RobolectricDeviceQualifiers
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Base class for Robolectric screenshot tests: the Android runner, native graphics (Roborazzi
 * needs it) and a Pixel 7. Subclasses call [captureScreens]; they may still add `@Config`.
 *
 * ```
 * class JobScreensTest : ScreenshotTest() {
 *     @Test fun list() = captureScreens("JobsList") { JobsList(listOf(Samples.workflow())) }
 * }
 * ```
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = RobolectricDeviceQualifiers.Pixel7)
abstract class ScreenshotTest
