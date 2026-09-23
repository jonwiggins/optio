package dev.optio.feature.widgets.screenshots

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import com.github.takahirom.roborazzi.captureRoboImage
import dev.optio.core.data.ServerColor
import dev.optio.core.testing.SCREENSHOT_DIR
import dev.optio.feature.widgets.run.RunTarget
import dev.optio.feature.widgets.run.RunWidgetContent
import dev.optio.feature.widgets.run.RunWidgetState
import dev.optio.feature.widgets.work.WidgetSamples
import dev.optio.feature.widgets.work.WorkFamily
import dev.optio.feature.widgets.work.WorkWidgetContent
import java.time.Instant
import java.util.TimeZone
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Contact sheets of every widget size and state, light and dark, rendered through `RemoteViews`
 * like a launcher (compare `apps/ios/Design/widgets`). Written by
 * `./gradlew :feature:widgets:recordRoborazziDebug` to `build/outputs/roborazzi/`.
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w412dp-h915dp-420dpi")
class WidgetScreenshotTest {
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")
    private val context: Context = ApplicationProvider.getApplicationContext()

    private val small = DpSize(170.dp, 170.dp)
    private val medium = DpSize(364.dp, 170.dp)
    private val large = DpSize(364.dp, 382.dp)

    @Before
    fun utc() {
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
    }

    private fun workCells(family: WorkFamily): List<Pair<String, @Composable () -> Unit>> =
        listOf(
            "waiting · 2 servers" to WidgetSamples.waiting(now),
            "one (others paired)" to WidgetSamples.one(now),
            "single" to WidgetSamples.single(now),
            "quiet" to WidgetSamples.quiet(now),
            "idle" to WidgetSamples.idle(now),
            "legacy server" to WidgetSamples.legacy(now),
            "offline" to WidgetSamples.offline(now),
            "partial" to WidgetSamples.partial(now),
            "stale" to WidgetSamples.stale(now),
            "signed out" to WidgetSamples.signedOut(now),
        ).map { (label, entry) -> label to @Composable { WorkWidgetContent(entry, family) } }

    private fun capture(
        name: String,
        size: DpSize,
        columns: Int,
        cells: List<Pair<String, @Composable () -> Unit>>,
    ) {
        for (dark in listOf(false, true)) {
            val sheet = WidgetSheets.sheet(context, dark, size, columns, cells)
            render(sheet).captureRoboImage("$SCREENSHOT_DIR/${name}_${if (dark) "dark" else "light"}.png")
        }
    }

    private fun render(view: View): Bitmap {
        val unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        view.measure(unspecified, unspecified)
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)
        return Bitmap.createBitmap(view.measuredWidth, view.measuredHeight, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
    }

    @Test
    fun workSmall() = capture("WorkWidget_small", small, columns = 3, workCells(WorkFamily.SMALL))

    @Test
    fun workMedium() = capture("WorkWidget_medium", medium, columns = 2, workCells(WorkFamily.MEDIUM))

    @Test
    fun workLarge() = capture("WorkWidget_large", large, columns = 2, workCells(WorkFamily.LARGE))

    @Test
    fun run() {
        val nightly = RunTarget("srv-laptop|job:nightly", "Nightly release notes", RunTarget.Kind.JOB)
        val deploy = RunTarget("srv-studio|local:deploy", "Deploy preview", RunTarget.Kind.LOCAL, spawnMode = "auto")
        val states =
            listOf(
                "idle" to RunWidgetState(true, nightly, confirm = true, startedAt = null, armedAt = null, now = now),
                "armed" to RunWidgetState(true, deploy, confirm = true, startedAt = null, armedAt = now.minusSeconds(2), now = now),
                "started" to RunWidgetState(true, deploy, confirm = false, startedAt = now.minusSeconds(2), armedAt = null, now = now),
                "two servers" to RunWidgetState(true, deploy, confirm = false, startedAt = null, armedAt = null, now = now, serverName = "Studio", serverColor = ServerColor.TEAL),
                "unconfigured" to RunWidgetState(true, null, confirm = true, startedAt = null, armedAt = null, now = now),
                "signed out" to RunWidgetState(false, nightly, confirm = true, startedAt = null, armedAt = null, now = now),
            ).map { (label, state) -> label to @Composable { RunWidgetContent(state) } }
        capture("RunWidget", small, columns = 3, states)
    }
}
