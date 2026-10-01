package dev.optio.core.ui.form

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

// Card rows shared by the New work form and the settings screens that reuse its agent picker (iOS
// `WorkFormControls.swift`): a menu row whose items can carry a check or be disabled with a reason,
// a trailing value field, a switch row, and the divider between rows.

private val RowPadding = PaddingValues(horizontal = Spacing.l, vertical = Spacing.m)

private val CODE_SPAN = Regex("`([^`]+)`")

/** [text] with its `code` spans set in mono (the copy names commands like `optio local up`). */
fun inlineCode(text: String): AnnotatedString = buildAnnotatedString {
    var last = 0
    for (m in CODE_SPAN.findAll(text)) {
        append(text.substring(last, m.range.first))
        withStyle(SpanStyle(fontFamily = FontFamily.Monospace)) { append(m.groupValues[1]) }
        last = m.range.last + 1
    }
    append(text.substring(last))
}


/** The hairline between two rows of a card. */
@Composable
fun RowDivider(start: androidx.compose.ui.unit.Dp = Spacing.l) = InsetDivider(start = start)


/** One item of a [MenuRow]'s menu. */
class MenuScope(val dismiss: () -> Unit)

/**
 * A row shaped like a menu picker (iOS `MenuRow`): label, current value, up/down chevron; a tap
 * opens a Material menu whose items ([MenuChoice]) can carry a check, a subtitle, or be disabled.
 * [placeholder] shows the value as a prompt ("Pick a directory…"), not an answer.
 */
@Composable
fun MenuRow(
    label: String,
    value: String,
    modifier: Modifier = Modifier,
    placeholder: Boolean = false,
    mono: Boolean = false,
    enabled: Boolean = true,
    /** A mark beside the value (the trigger's brand, a ticket source's logo). */
    leadingIcon: ImageVector? = null,
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
            if (leadingIcon != null && !placeholder) {
                Spacer(Modifier.weight(1f))
                Icon(leadingIcon, contentDescription = null, tint = colors.secondaryLabel, modifier = Modifier.size(16.dp))
            }
            Text(
                value,
                style = if (mono && !placeholder) OptioTheme.type.monoSubheadline else OptioTheme.type.body,
                color = if (placeholder) colors.tertiaryLabel else colors.secondaryLabel,
                maxLines = 1,
                overflow = if (mono) TextOverflow.StartEllipsis else TextOverflow.Ellipsis,
                textAlign = TextAlign.End,
                modifier = if (leadingIcon != null && !placeholder) Modifier else Modifier.weight(1f),
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
fun MenuScope.MenuChoice(
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
fun MenuScope.MenuCaption(text: String) {
    Text(
        inlineCode(text),
        style = OptioTheme.type.caption.copy(fontWeight = FontWeight.SemiBold),
        color = OptioTheme.colors.secondaryLabel,
        modifier = Modifier.padding(horizontal = Spacing.l, vertical = Spacing.s),
    )
}

@Composable
fun MenuScope.MenuDivider() = HorizontalDivider(Modifier.padding(vertical = Spacing.xs))

/**
 * A short value on the trailing side of its label, the way Settings edits a hostname (iOS
 * `ValueField`): "Branch        main". [prefix] (e.g. `/api/hooks/`) sits before the field.
 */
@Composable
fun ValueField(
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


/** A toggle row: title, optional help line, a switch. */
@Composable
fun SwitchRow(
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

