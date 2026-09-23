package dev.optio.feature.tasks.common

import androidx.compose.ui.text.AnnotatedString

/**
 * The detail headers here let their `·` facts wrap to a second line: next to a wide badge (NEEDS
 * ATTENTION) a one-line middle cut hid the model, or split the cost (`$0.0…1k`).
 */
internal const val HEADER_LINE_MAX_LINES = 2

private const val SEPARATOR = '·'
private const val NO_BREAK_SPACE = ' '

/**
 * This `·`-joined line with its spaces made non-breaking inside each fact, so a wrapped line
 * breaks between facts (`… · fake-model ·` / `Claude Code · $0.42`) and never inside one
 * (`Claude` / `Code`). Same length, so the mono spans keep their ranges.
 */
internal fun AnnotatedString.keepFactsTogether(): AnnotatedString {
    val chars = text.toCharArray()
    for (i in chars.indices) {
        if (chars[i] != ' ') continue
        val besideSeparator = chars.getOrNull(i - 1) == SEPARATOR || chars.getOrNull(i + 1) == SEPARATOR
        if (!besideSeparator) chars[i] = NO_BREAK_SPACE
    }
    return AnnotatedString(String(chars), spanStyles, paragraphStyles)
}
