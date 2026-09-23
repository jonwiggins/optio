package dev.optio.feature.workform

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.RowScope
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.selection.selectable
import androidx.compose.foundation.selection.toggleable
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Check
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material.icons.filled.UnfoldMore
import androidx.compose.material3.Checkbox
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.FilterChip
import androidx.compose.material3.FilterChipDefaults
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.SegmentedButton
import androidx.compose.material3.SegmentedButtonDefaults
import androidx.compose.material3.SingleChoiceSegmentedButtonRow
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.focus.FocusRequester
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.semantics.stateDescription
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.text.input.TextFieldValue
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.InsetDivider
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Radius
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.tabularNums

// The pieces the work form is built from, shaped like rows of one grouped card so the screen
// reads as one system (iOS `WorkFormControls.swift`): a sentence-case section header with its
// question, an exclusive-choice row with a check, a menu row whose items can be disabled with a
// reason, a trailing value field, chip rows, switch / check / stepper rows, and a prompt editor
// that grows with its text and keeps the caret so a `{{param}}` chip can insert at it.

private val RowPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.m)

private val CODE_SPAN = Regex("`([^`]+)`")

/** [text] with its `code` spans set in mono (the copy names commands like `optio local up`). */
internal fun inlineCode(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in CODE_SPAN.findAll(text)) {
        append(text.substring(last, m.range.first))
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(m.groupValues[1]) }
        last = m.range.last + 1
    }
    append(text.substring(last))
}

/**
 * One attribute of the form: "When · What starts it?" over one card of rows, an optional footer
 * under it. [trailing] sits at the header's end (the "Saved prompts" menu).
 */
@Composable
internal fun FormSectionCard(
    title: String?,
    modifier: Modifier = Modifier,
    question: String? = null,
    footer: String? = null,
    trailing: (@Composable RowScope.() -> Unit)? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    val colors = OptioTheme.colors
    Column(modifier.fillMaxWidth().padding(horizontal = Spacing.l)) {
        if (title == null) {
            Spacer(Modifier.heightIn(min = Spacing.l))
        } else Row(
            Modifier
                .fillMaxWidth()
                .heightIn(min = 40.dp)
                .padding(start = Spacing.l, end = Spacing.xs, top = Spacing.m, bottom = Spacing.xs)
                .semantics(mergeDescendants = true) { heading() },
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(title, style = OptioTheme.type.sectionHeader, color = colors.secondaryLabel, maxLines = 1)
            if (question != null) {
                Text(
                    question,
                    style = OptioTheme.type.footnote,
                    color = colors.tertiaryLabel,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                    modifier = Modifier.weight(1f),
                )
            } else {
                Spacer(Modifier.weight(1f))
            }
            trailing?.invoke(this)
        }
        Column(Modifier.fillMaxWidth().background(colors.card, Radius.cardShape), content = content)
        if (footer != null) {
            Text(
                inlineCode(footer),
                style = OptioTheme.type.footnote,
                color = colors.secondaryLabel,
                modifier = Modifier.padding(start = Spacing.l, end = Spacing.l, top = Spacing.s),
            )
        }
    }
}

/** The hairline between two rows of a card. */
@Composable
internal fun RowDivider(start: androidx.compose.ui.unit.Dp = Spacing.l) = InsetDivider(start = start)

/**
 * One of an exclusive set (the web's `ModeCard` / `LocationCard`, iOS `ChoiceRow`): symbol, title,
 * one-line subtitle, a check on the chosen one. A choice that can't be picked dims and says why.
 */
@Composable
internal fun ChoiceRow(
    icon: ImageVector,
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
    disabled: String? = null,
) {
    val colors = OptioTheme.colors
    val enabled = disabled == null
    val haptics = LocalHapticFeedback.current
    Row(
        modifier
            .fillMaxWidth()
            .selectable(
                selected = selected,
                enabled = enabled,
                role = Role.RadioButton,
                onClick = {
                    if (!selected) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    onClick()
                },
            )
            .padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Icon(
            icon,
            contentDescription = null,
            tint = when {
                !enabled -> colors.quaternaryLabel
                selected -> colors.accent
                else -> colors.secondaryLabel
            },
            modifier = Modifier.size(24.dp),
        )
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = OptioTheme.type.body, color = if (enabled) colors.label else colors.tertiaryLabel)
            val line = disabled ?: subtitle
            if (line != null) {
                Text(inlineCode(line), style = OptioTheme.type.footnote, color = if (enabled) colors.secondaryLabel else colors.tertiaryLabel)
            }
        }
        if (selected) {
            Icon(Icons.Filled.Check, contentDescription = null, tint = colors.accent, modifier = Modifier.size(22.dp))
        } else {
            Spacer(Modifier.width(22.dp))
        }
    }
}

/** One item of a [MenuRow]'s menu. */
internal class MenuScope(val dismiss: () -> Unit)

/**
 * A row shaped like a menu picker (iOS `MenuRow`): label, current value, up/down chevron; a tap
 * opens a Material menu whose items ([MenuChoice]) can carry a check, a subtitle, or be disabled.
 * [placeholder] shows the value as a prompt ("Pick a directory…"), not an answer.
 */
@Composable
internal fun MenuRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    placeholder: Boolean = false,
    mono: Boolean = false,
    enabled: Boolean = true,
    items: @Composable MenuScope.() -> Unit,
) {
    val colors = OptioTheme.colors
    var expanded by remember { mutableStateOf(false) }
    Box(modifier.fillMaxWidth()) {
        Row(
            Modifier
                .fillMaxWidth()
                .clickable(enabled = enabled, role = Role.DropdownList, onClickLabel = "Choose $label") { expanded = true }
                .semantics(mergeDescendants = true) {
                    contentDescription = label
                    stateDescription = value
                }
                .padding(RowPadding),
            verticalAlignment = Alignment.CenterVertically,
            horizontalArrangement = Arrangement.spacedBy(Spacing.s),
        ) {
            Text(label, style = OptioTheme.type.body, color = if (enabled) colors.label else colors.tertiaryLabel, maxLines = 1)
            Spacer(Modifier.width(Spacing.xs))
            Text(
                value,
                style = if (mono && !placeholder) OptioTheme.type.monoSubheadline else OptioTheme.type.body,
                color = if (placeholder) colors.tertiaryLabel else colors.secondaryLabel,
                maxLines = 1,
                overflow = if (mono) TextOverflow.StartEllipsis else TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = Modifier.weight(1f),
            )
            Icon(Icons.Filled.UnfoldMore, contentDescription = null, tint = colors.tertiaryLabel, modifier = Modifier.size(16.dp))
        }
        // A zero-size anchor at the row's bottom end: the menu opens under the value.
        Box(Modifier.align(Alignment.BottomEnd).padding(end = Spacing.l)) {
            DropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
                MenuScope { expanded = false }.items()
            }
        }
    }
}

/** A menu item that shows a check when it is the current value (iOS `MenuChoice`). */
@Composable
internal fun MenuScope.MenuChoice(
    title: String,
    selected: Boolean,
    onClick: () -> Unit,
    subtitle: String? = null,
    enabled: Boolean = true,
    icon: ImageVector? = null,
    mono: Boolean = false,
) {
    val colors = OptioTheme.colors
    DropdownMenuItem(
        text = {
            Column(Modifier.widthIn(max = 300.dp), verticalArrangement = Arrangement.spacedBy(2.dp)) {
                Text(
                    title,
                    style = if (mono) OptioTheme.type.monoSubheadline else MaterialTheme.typography.bodyLarge,
                    fontWeight = if (selected) FontWeight.SemiBold else null,
                )
                if (subtitle != null) Text(subtitle, style = OptioTheme.type.footnote, color = colors.secondaryLabel)
            }
        },
        leadingIcon = {
            when {
                selected -> Icon(Icons.Filled.Check, contentDescription = "Selected", tint = colors.accent)
                icon != null -> Icon(icon, contentDescription = null)
                else -> Spacer(Modifier.size(24.dp))
            }
        },
        enabled = enabled,
        onClick = {
            dismiss()
            onClick()
        },
    )
}

/** A non-interactive caption inside a menu (a model family, a hint). */
@Composable
internal fun MenuScope.MenuCaption(text: String) {
    Text(
        inlineCode(text),
        style = OptioTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
    )
}

@Composable
internal fun MenuScope.MenuDivider() = HorizontalDivider(Modifier.padding(vertical = Spacing.xs))

/**
 * A short value on the trailing side of its label, the way Settings edits a hostname (iOS
 * `ValueField`): "Branch        main". [prefix] (e.g. `/api/hooks/`) sits before the field.
 */
@Composable
internal fun ValueField(
    label: String,
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = true,
    prefix: String? = null,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.None,
    keyboardType: KeyboardType = KeyboardType.Ascii,
    imeAction: ImeAction = ImeAction.Done,
    fieldTag: String? = null,
) {
    val colors = OptioTheme.colors
    val focus = remember { FocusRequester() }
    val style = (if (mono) OptioTheme.type.monoBody else OptioTheme.type.body).copy(
        color = colors.label,
        textAlign = if (prefix == null) TextAlign.End else TextAlign.Start,
    )
    Row(
        modifier
            .fillMaxWidth()
            .clickable(interactionSource = remember { MutableInteractionSource() }, indication = null) { focus.requestFocus() }
            .padding(RowPadding),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(label, style = OptioTheme.type.body, color = colors.label, maxLines = 1)
        Spacer(Modifier.width(Spacing.xs))
        if (prefix != null) {
            Text(prefix, style = OptioTheme.type.monoSubheadline, color = colors.tertiaryLabel, maxLines = 1)
        }
        BasicTextField(
            value = value,
            onValueChange = onValueChange,
            singleLine = true,
            textStyle = style,
            cursorBrush = SolidColor(colors.accent),
            keyboardOptions = KeyboardOptions(
                capitalization = capitalization,
                autoCorrectEnabled = false,
                keyboardType = keyboardType,
                imeAction = imeAction,
            ),
            modifier = Modifier
                .weight(1f)
                .focusRequester(focus)
                .semantics { contentDescription = label }
                .then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
            decorationBox = { inner ->
                Box(contentAlignment = if (prefix == null) Alignment.CenterEnd else Alignment.CenterStart) {
                    if (value.isEmpty()) {
                        Text(placeholder, style = style.copy(color = colors.tertiaryLabel), maxLines = 1, overflow = TextOverflow.Ellipsis)
                    }
                    inner()
                }
            },
        )
    }
}

/**
 * A free text row with its own label above the field (a name, a description, a system prompt).
 * [minLines] > 1 makes it grow with its text.
 */
@Composable
internal fun TextAreaRow(
    value: String,
    onValueChange: (String) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    minLines: Int = 1,
    maxLines: Int = if (minLines > 1) 12 else 1,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
    imeAction: ImeAction = if (maxLines == 1) ImeAction.Done else ImeAction.Default,
    fieldTag: String? = null,
    contentDescription: String = placeholder,
) {
    val colors = OptioTheme.colors
    val style = (if (mono) OptioTheme.type.monoSubheadline else OptioTheme.type.body).copy(color = colors.label)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        singleLine = maxLines == 1,
        minLines = minLines,
        maxLines = maxLines,
        textStyle = style,
        cursorBrush = SolidColor(colors.accent),
        keyboardOptions = KeyboardOptions(
            capitalization = if (mono) KeyboardCapitalization.None else capitalization,
            autoCorrectEnabled = !mono,
            imeAction = imeAction,
        ),
        modifier = modifier
            .fillMaxWidth()
            .semantics { this.contentDescription = contentDescription }
            .then(if (fieldTag != null) Modifier.testTag(fieldTag) else Modifier),
        decorationBox = { inner ->
            Box(Modifier.padding(RowPadding)) {
                if (value.isEmpty()) Text(placeholder, style = style.copy(color = colors.tertiaryLabel))
                inner()
            }
        },
    )
}

/**
 * The prompt: a growing editor (the form scrolls, not the field) that keeps the caret, so a
 * `{{param}}` chip can insert at it (iOS `PromptEditor`).
 */
@Composable
internal fun PromptEditor(
    value: TextFieldValue,
    onValueChange: (TextFieldValue) -> Unit,
    placeholder: String,
    modifier: Modifier = Modifier,
    focusRequester: FocusRequester = remember { FocusRequester() },
) {
    val colors = OptioTheme.colors
    val style = OptioTheme.type.body.copy(color = colors.label)
    BasicTextField(
        value = value,
        onValueChange = onValueChange,
        textStyle = style,
        minLines = 5,
        cursorBrush = SolidColor(colors.accent),
        keyboardOptions = KeyboardOptions(capitalization = KeyboardCapitalization.Sentences),
        keyboardActions = KeyboardActions.Default,
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 128.dp)
            .focusRequester(focusRequester)
            .semantics { contentDescription = "Prompt" }
            .testTag("work-form-prompt"),
        decorationBox = { inner ->
            Box(Modifier.padding(horizontal = Spacing.l, vertical = Spacing.m)) {
                if (value.text.isEmpty()) Text(placeholder, style = style.copy(color = colors.tertiaryLabel))
                inner()
            }
        },
    )
}

/** One chip in a [FormChipRow]. */
internal data class FormChip<T>(val value: T, val label: String, val icon: ImageVector? = null)

/**
 * Chips that scroll edge to edge inside a row (iOS `ChipRow`); the selected one is the app's
 * inverted pill. Each chip gets the test tag `chip-<label>`.
 */
@Composable
internal fun <T> FormChipRow(
    chips: List<FormChip<T>>,
    selection: T?,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    contentPadding: PaddingValues = PaddingValues(horizontal = Spacing.l, vertical = Spacing.s),
) {
    val colors = OptioTheme.colors
    val haptics = LocalHapticFeedback.current
    Row(
        modifier.fillMaxWidth().horizontalScroll(rememberScrollState()).padding(contentPadding),
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        chips.forEach { chip ->
            val selected = chip.value == selection
            FilterChip(
                selected = selected,
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    onSelect(chip.value)
                },
                label = {
                    Text(
                        chip.label,
                        style = if (mono) OptioTheme.type.monoFootnote else OptioTheme.type.subheadline,
                        fontWeight = if (selected) FontWeight.SemiBold else FontWeight.Normal,
                        maxLines = 1,
                    )
                },
                leadingIcon = chip.icon?.let { icon -> { Icon(icon, contentDescription = null, modifier = Modifier.size(16.dp)) } },
                colors = FilterChipDefaults.filterChipColors(
                    containerColor = colors.fillTertiary,
                    labelColor = colors.label,
                    iconColor = colors.label,
                    selectedContainerColor = colors.label,
                    selectedLabelColor = colors.page,
                    selectedLeadingIconColor = colors.page,
                ),
                border = null,
                modifier = Modifier.testTag("chip-${chip.label}"),
            )
        }
    }
}

/**
 * An either / or inside a card (iOS segmented `Picker`): a Material segmented row. A disabled
 * option (never the selected one) can't be picked; [onDisabled] reports why.
 */
@Composable
internal fun <T> SegmentedRow(
    options: List<Pair<T, String>>,
    selection: T,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    disabled: (T) -> String? = { null },
) {
    val haptics = LocalHapticFeedback.current
    SingleChoiceSegmentedButtonRow(modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.s)) {
        options.forEachIndexed { index, (value, label) ->
            val reason = disabled(value)?.takeIf { value != selection }
            SegmentedButton(
                selected = value == selection,
                onClick = {
                    if (value != selection) haptics.performHapticFeedback(HapticFeedbackType.SegmentTick)
                    onSelect(value)
                },
                enabled = reason == null,
                shape = SegmentedButtonDefaults.itemShape(index = index, count = options.size),
                icon = {},
                label = { Text(label, maxLines = 1, overflow = TextOverflow.Ellipsis) },
                modifier = Modifier.testTag("segment-$label"),
            )
        }
    }
}

/** A toggle row: title, optional help line, a switch. */
@Composable
internal fun SwitchRow(
    title: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    subtitle: String? = null,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Switch, onValueChange = onCheckedChange)
            .padding(horizontal = Spacing.l, vertical = Spacing.s),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(title, style = OptioTheme.type.body, color = colors.label)
            if (subtitle != null) Text(subtitle, style = OptioTheme.type.footnote, color = colors.secondaryLabel)
        }
        Switch(checked = checked, onCheckedChange = null)
    }
}

/** A multi-select row: a checkbox and its label (event kinds). */
@Composable
internal fun CheckRow(
    title: String,
    checked: Boolean,
    onToggle: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Row(
        modifier
            .fillMaxWidth()
            .toggleable(value = checked, role = Role.Checkbox, onValueChange = { onToggle() })
            .padding(start = Spacing.xs, end = Spacing.l),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Checkbox(checked = checked, onCheckedChange = null, modifier = Modifier.padding(Spacing.m))
        Text(title, style = OptioTheme.type.body, color = OptioTheme.colors.label)
    }
}

/** A number with − / + (iOS `Stepper`). */
@Composable
internal fun StepperRow(
    label: String,
    value: Int,
    range: IntRange,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    step: Int = 1,
) {
    val colors = OptioTheme.colors
    Row(
        modifier
            .fillMaxWidth()
            .padding(start = Spacing.l, end = Spacing.xs)
            .semantics(mergeDescendants = true) {
                contentDescription = label
                stateDescription = value.toString()
                role = Role.Button
            },
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Text(label, style = OptioTheme.type.body, color = colors.label, modifier = Modifier.weight(1f))
        IconButton(onClick = { onValueChange((value - step).coerceIn(range)) }, enabled = value > range.first) {
            Icon(Icons.Filled.Remove, contentDescription = "Decrease $label")
        }
        Text(
            value.toString(),
            style = OptioTheme.type.body.tabularNums(),
            color = colors.secondaryLabel,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(min = 40.dp),
        )
        IconButton(onClick = { onValueChange((value + step).coerceIn(range)) }, enabled = value < range.last) {
            Icon(Icons.Filled.Add, contentDescription = "Increase $label")
        }
    }
}

/** A footnote inside a card (a hint under a control), set like a row's secondary line. */
@Composable
internal fun CardNote(text: String, modifier: Modifier = Modifier, style: TextStyle = OptioTheme.type.footnote) {
    Text(
        inlineCode(text),
        style = style,
        color = OptioTheme.colors.secondaryLabel,
        modifier = modifier.fillMaxWidth().padding(start = Spacing.l, end = Spacing.l, bottom = Spacing.m),
    )
}
