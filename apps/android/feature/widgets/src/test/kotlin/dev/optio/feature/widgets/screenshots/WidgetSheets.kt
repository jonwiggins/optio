package dev.optio.feature.widgets.screenshots

import android.content.Context
import android.content.res.Configuration
import android.graphics.Color
import android.graphics.Typeface
import android.util.TypedValue
import android.view.View
import android.view.ViewGroup
import android.widget.FrameLayout
import android.widget.GridLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.compose.runtime.Composable
import androidx.compose.ui.unit.DpSize
import androidx.glance.GlanceId
import androidx.glance.appwidget.GlanceAppWidget
import androidx.glance.appwidget.SizeMode
import androidx.glance.appwidget.compose
import androidx.glance.appwidget.provideContent
import kotlinx.coroutines.runBlocking

/** A throwaway widget that renders [content] (the real widget composables, fed sample data). */
private class SampleWidget(private val content: @Composable () -> Unit) : GlanceAppWidget() {
    override val sizeMode: SizeMode = SizeMode.Exact

    override suspend fun provideGlance(
        context: Context,
        id: GlanceId,
    ) = provideContent { content() }
}

/**
 * Renders Glance content the way a launcher does: compose to `RemoteViews`, then inflate them into
 * real views, so a screenshot shows exactly what the home screen would (layouts, day/night colours,
 * corner radius, ellipsizing).
 */
internal object WidgetSheets {
    /** [context] in light or dark mode (the widgets' day/night colours resolve against it). */
    fun themed(
        context: Context,
        dark: Boolean,
    ): Context {
        val config = Configuration(context.resources.configuration)
        config.uiMode = (config.uiMode and Configuration.UI_MODE_NIGHT_MASK.inv()) or
            (if (dark) Configuration.UI_MODE_NIGHT_YES else Configuration.UI_MODE_NIGHT_NO)
        return context.createConfigurationContext(config)
    }

    /** One widget at [size], as the launcher would inflate it. */
    fun widget(
        context: Context,
        size: DpSize,
        content: @Composable () -> Unit,
    ): View {
        val views = runBlocking { SampleWidget(content).compose(context, size = size) }
        val host = FrameLayout(context)
        val view = views.apply(context, host)
        host.addView(view, FrameLayout.LayoutParams(px(context, size.width.value), px(context, size.height.value)))
        return host
    }

    /**
     * A contact sheet: each cell's label over its widget, [columns] per row, on a wallpaper-like
     * background (light grey or black), like `apps/ios/Design/widgets`.
     */
    fun sheet(
        context: Context,
        dark: Boolean,
        size: DpSize,
        columns: Int,
        cells: List<Pair<String, @Composable () -> Unit>>,
    ): View {
        val themed = themed(context, dark)
        val grid =
            GridLayout(themed).apply {
                columnCount = columns
                setBackgroundColor(if (dark) Color.BLACK else Color.rgb(0xE5, 0xE5, 0xEA))
                val pad = px(themed, 16f)
                setPadding(pad, pad, pad, pad)
            }
        for ((label, content) in cells) {
            val cell =
                LinearLayout(themed).apply {
                    orientation = LinearLayout.VERTICAL
                    val pad = px(themed, 8f)
                    setPadding(pad, pad, pad, pad)
                }
            cell.addView(
                TextView(themed).apply {
                    text = label
                    setTextColor(if (dark) Color.WHITE else Color.rgb(0x1C, 0x1C, 0x1E))
                    setTextSize(TypedValue.COMPLEX_UNIT_SP, 13f)
                    typeface = Typeface.DEFAULT
                    setPadding(0, 0, 0, px(themed, 6f))
                },
            )
            cell.addView(widget(themed, size, content), LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT))
            grid.addView(cell)
        }
        return grid
    }

    fun px(
        context: Context,
        dp: Float,
    ): Int = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, dp, context.resources.displayMetrics).toInt()
}
