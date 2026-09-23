package dev.optio.core.ui.components

import androidx.compose.foundation.ExperimentalFoundationApi
import androidx.compose.foundation.combinedClickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.automirrored.filled.KeyboardArrowRight
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.Tone
import dev.optio.core.ui.theme.tabularNums

/** The " · " that joins meta parts. */
const val META_SEPARATOR = " · "

/**
 * `·`-joined meta line (iOS `Text.meta`): drops nulls and empty strings, keeps each part's styling
 * (pass [mono] parts for paths, branches and `#519`). Null when nothing is left.
 */
fun metaText(vararg parts: CharSequence?): AnnotatedString? = metaText(parts.asList())

/** [metaText] over a list. */
fun metaText(parts: List<CharSequence?>): AnnotatedString? {
    val present = parts.filterNotNull().filter { it.isNotEmpty() }
    if (present.isEmpty()) return null
    return buildAnnotatedString {
        present.forEachIndexed { index, part ->
            if (index > 0) append(META_SEPARATOR)
            append(part)
        }
    }
}

/** A mono span (iOS `Text.mono`) for paths, branches, PR numbers and slugs inside a meta line. */
fun mono(text: String): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(text) }
}

/** A span in a colour (a tone's text colour inside a meta line: `tinted("Failed", red)`). */
fun tinted(text: String, color: Color): AnnotatedString = buildAnnotatedString {
    withStyle(SpanStyle(color = color)) { append(text) }
}

object OptioRowDefaults {
    /** Screen gutter horizontally, 12dp vertically: a two-line row lands on Material's 72dp. */
    val ContentPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.m)
}

/**
 * The one list row (iOS `OptioRow`, docs/design/ios-ui-review.md "Row anatomy"): a leading state
 * dot only when the tone shows one (needs you, failed, working), a body title (two lines), one
 * `·`-joined secondary [meta] line, an optional tertiary [footer], and trailing meta (a relative
 * time or a terminal state like "Merged", tertiary unless [trailingTone]). No badges in rows.
 *
 * Clickable when [onClick] / [onLongClick] are set. [leading] replaces the dot (a server dot, an
 * avatar); [trailingContent] goes after the trailing text (a switch, a menu button).
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun OptioRow(
    title: String,
    modifier: Modifier = Modifier,
    tone: Tone? = null,
    meta: AnnotatedString? = null,
    trailing: String? = null,
    trailingTone: Tone? = null,
    footer: AnnotatedString? = null,
    footerTone: Tone? = null,
    titleMaxLines: Int = 2,
    leading: (@Composable () -> Unit)? = null,
    trailingContent: (@Composable RowScope.() -> Unit)? = null,
    onClick: (() -> Unit)? = null,
    onLongClick: (() -> Unit)? = null,
    onClickLabel: String? = null,
    contentPadding: PaddingValues = OptioRowDefaults.ContentPadding,
) {
    val type = OptioTheme.type
    val colors = OptioTheme.colors
    val clickable = if (onClick != null || onLongClick != null) {
        Modifier.combinedClickable(
            onClick = onClick ?: {},
            onLongClick = onLongClick,
            onClickLabel = onClickLabel,
            role = Role.Button,
        )
    } else {
        Modifier
    }
    // Centre the dot on the title's first line.
    val firstLine = with(LocalDensity.current) { type.body.lineHeight.toDp() }
    Row(
        modifier = modifier.fillMaxWidth().then(clickable).padding(contentPadding),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        when {
            leading != null -> Row(Modifier.padding(top = centeredTop(firstLine, 8.dp))) { leading() }
            tone != null && tone.showsDot -> StateDot(tone, Modifier.padding(top = centeredTop(firstLine, 7.dp)))
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.xs)) {
            Text(title, style = type.body, color = colors.label, maxLines = titleMaxLines, overflow = TextOverflow.Ellipsis)
            if (meta != null) {
                Text(meta, style = type.subheadline, color = colors.secondaryLabel, maxLines = 1, overflow = TextOverflow.Ellipsis)
            }
            if (footer != null) {
                Text(
                    footer,
                    style = type.footnote,
                    color = footerTone?.textColor ?: colors.tertiaryLabel,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (trailing != null) {
            Text(
                trailing,
                style = type.footnote.tabularNums(),
                color = trailingTone?.textColor ?: colors.tertiaryLabel,
                maxLines = 1,
                modifier = Modifier.padding(start = Spacing.xs, top = 3.dp),
            )
        }
        if (trailingContent != null) {
            Row(verticalAlignment = Alignment.CenterVertically, content = trailingContent)
        }
    }
}

private fun centeredTop(lineHeight: Dp, itemHeight: Dp): Dp = ((lineHeight - itemHeight) / 2).coerceAtLeast(0.dp)

/**
 * A section header (iOS `SectionHeader`): footnote semibold, secondary, sentence case, an optional
 * tertiary [detail] (a count), and a trailing chevron when [action] makes it tappable.
 */
@Composable
fun SectionHeader(
    title: String,
    modifier: Modifier = Modifier,
    detail: String? = null,
    tone: Tone? = null,
    action: (() -> Unit)? = null,
    contentPadding: PaddingValues = SectionHeaderDefaults.ContentPadding,
) {
    val colors = OptioTheme.colors
    val clickable = if (action != null) {
        Modifier.combinedClickable(onClick = action, role = Role.Button)
    } else {
        Modifier
    }
    Row(
        modifier = modifier.fillMaxWidth().then(clickable).padding(contentPadding).semantics { heading() },
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.xs),
    ) {
        Text(title, style = OptioTheme.type.sectionHeader, color = tone?.textColor ?: colors.secondaryLabel, maxLines = 1)
        if (detail != null) {
            Text(detail, style = OptioTheme.type.footnote.tabularNums(), color = colors.tertiaryLabel, maxLines = 1)
        }
        Spacer(Modifier.weight(1f))
        if (action != null) {
            Icon(
                Icons.AutoMirrored.Filled.KeyboardArrowRight,
                contentDescription = null,
                tint = colors.tertiaryLabel,
                modifier = Modifier.size(18.dp),
            )
        }
    }
}

object SectionHeaderDefaults {
    /** Screen gutter; more air above than below so the header binds to its section. */
    val ContentPadding = PaddingValues(start = Spacing.l, end = Spacing.l, top = Spacing.l + Spacing.xs, bottom = Spacing.s)

    /** Inside a card (no gutter, no top air). */
    val InCard = PaddingValues(0.dp)
}

/**
 * Label on the left, value on the right (iOS `LabeledContent` / `MoreInfoRow`): details and
 * settings. [mono] values (ids, paths, cron) truncate in the middle.
 */
@OptIn(ExperimentalFoundationApi::class)
@Composable
fun KeyValueRow(
    label: String,
    value: String?,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    valueColor: Color = OptioTheme.colors.secondaryLabel,
    onClick: (() -> Unit)? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    contentPadding: PaddingValues = OptioRowDefaults.ContentPadding,
) {
    val type = OptioTheme.type
    val clickable = if (onClick != null) Modifier.combinedClickable(onClick = onClick, role = Role.Button) else Modifier
    Row(
        modifier = modifier.fillMaxWidth().then(clickable).padding(contentPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Text(label, style = type.body, color = OptioTheme.colors.label, maxLines = 1)
        if (value != null) {
            Text(
                value,
                style = if (mono) type.monoSubheadline else type.body,
                color = valueColor,
                maxLines = 1,
                overflow = if (mono) TextOverflow.MiddleEllipsis else TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
        } else {
            Spacer(Modifier.weight(1f))
        }
        if (trailing != null) Row(verticalAlignment = Alignment.CenterVertically, content = trailing)
    }
}

/**
 * A hairline between rows, inset from the leading edge like an iOS list separator. Pass
 * `start = 0.dp` for a full-width rule.
 */
@Composable
fun InsetDivider(
    modifier: Modifier = Modifier,
    start: Dp = Spacing.l,
    end: Dp = 0.dp,
) {
    HorizontalDivider(
        modifier = modifier.padding(start = start, end = end),
        thickness = Dp.Hairline,
        color = OptioTheme.colors.separator,
    )
}
