package dev.optio.feature.widgets.tools

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.view.View
import androidx.compose.ui.unit.DpSize
import androidx.compose.ui.unit.dp
import androidx.core.graphics.scale
import androidx.test.core.app.ApplicationProvider
import androidx.test.ext.junit.runners.AndroidJUnit4
import dev.optio.feature.widgets.run.RunWidgetContent
import dev.optio.feature.widgets.run.RunWidgetState
import dev.optio.feature.widgets.screenshots.WidgetSheets
import dev.optio.feature.widgets.work.WidgetSamples
import dev.optio.feature.widgets.work.WorkFamily
import dev.optio.feature.widgets.work.WorkWidgetContent
import java.io.File
import java.time.Instant
import java.util.TimeZone
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.annotation.Config
import org.robolectric.annotation.GraphicsMode

/**
 * Writes the widget picker's preview images (`android:previewImage`) from the real widget layouts
 * with sample data, light mode. Opt-in:
 *
 * ```
 * OPTIO_GENERATE_WIDGET_PREVIEWS=1 ./gradlew :feature:widgets:testDebugUnitTest --tests '*WidgetPreviewGenerator*'
 * ```
 */
@RunWith(AndroidJUnit4::class)
@GraphicsMode(GraphicsMode.Mode.NATIVE)
@Config(qualifiers = "w412dp-h915dp-420dpi")
class WidgetPreviewGenerator {
    private val context: Context = ApplicationProvider.getApplicationContext()
    private val now: Instant = Instant.parse("2026-09-22T16:40:00Z")

    @Test
    fun generate() {
        assumeTrue("set OPTIO_GENERATE_WIDGET_PREVIEWS=1 to regenerate", System.getenv("OPTIO_GENERATE_WIDGET_PREVIEWS") == "1")
        TimeZone.setDefault(TimeZone.getTimeZone("UTC"))
        val light = WidgetSheets.themed(context, dark = false)
        write("widget_preview_work", WidgetSheets.widget(light, DpSize(364.dp, 170.dp)) { WorkWidgetContent(WidgetSamples.single(now), WorkFamily.MEDIUM) })
        write("widget_preview_run", WidgetSheets.widget(light, DpSize(170.dp, 170.dp)) { RunWidgetContent(RunWidgetState.sample(now)) })
    }

    private fun write(
        name: String,
        view: View,
    ) {
        val unspecified = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED)
        view.measure(unspecified, unspecified)
        view.layout(0, 0, view.measuredWidth, view.measuredHeight)
        val full = Bitmap.createBitmap(view.measuredWidth, view.measuredHeight, Bitmap.Config.ARGB_8888).also { view.draw(Canvas(it)) }
        // Half the 420 dpi render: plenty for a picker thumbnail, a fraction of the bytes.
        val small = full.scale(full.width / 2, full.height / 2)
        val dir = File("src/main/res/drawable-nodpi").apply { mkdirs() }
        File(dir, "$name.png").outputStream().use { small.compress(Bitmap.CompressFormat.PNG, 100, it) }
    }
}
