package dev.optio.feature.widgets.ui

import android.content.Context
import android.graphics.Paint
import android.graphics.Typeface
import android.text.TextPaint
import android.util.DisplayMetrics
import android.util.TypedValue

/**
 * Fits a large row's Where chip beside its When, Who and Then chips. iOS lets Where shrink first
 * (`layoutPriority(-1)`, head truncation); a widget's text can only ellipsize at its end, so the
 * label is chosen up front by measuring it: `host · leaf` when it fits, else the leaf, else the
 * leaf cut from the front (`…ps/web`).
 */
internal object ChipFit {
    /** A chip's icon size and the gap before its label, in dp. */
    const val ICON = 10
    const val ICON_GAP = 3

    /** The gap between chips, in dp. */
    const val GAP = 8

    /** Kept free for rounding and the launcher's own font metrics, in dp. */
    private const val SLACK = 4f

    /** The Where label for a row [roomDp] wide whose other chips read [others]. */
    fun where(
        context: Context,
        roomDp: Float,
        others: List<String>,
        full: String,
    ): String {
        val metrics = context.resources.displayMetrics
        val sans = paint(metrics, Typeface.DEFAULT)
        val mono = paint(metrics, Typeface.MONOSPACE)
        val chrome = 4 * (ICON + ICON_GAP) + 3 * GAP + SLACK
        val budget = roomDp - chrome - others.sumOf { sans.measureText(it).toDouble() }.toFloat() / metrics.density

        fun fits(label: String) = mono.measureText(label) / metrics.density <= budget
        if (fits(full)) return full
        val leaf = full.substringAfterLast(" · ")
        if (fits(leaf)) return leaf
        var chars = leaf.length - 1
        while (chars > 1 && !fits(truncateHead(leaf, chars))) chars--
        return truncateHead(leaf, chars)
    }

    private fun paint(
        metrics: DisplayMetrics,
        face: Typeface,
    ) = TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
        textSize = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, WidgetType.caption2.value, metrics)
        typeface = face
    }
}
