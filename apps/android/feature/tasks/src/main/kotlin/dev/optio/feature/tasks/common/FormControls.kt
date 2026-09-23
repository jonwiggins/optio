package dev.optio.feature.tasks.common

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Add
import androidx.compose.material.icons.filled.Remove
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExposedDropdownMenuAnchorType
import androidx.compose.material3.ExposedDropdownMenuBox
import androidx.compose.material3.ExposedDropdownMenuDefaults
import androidx.compose.material3.FilledTonalIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.input.KeyboardCapitalization
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.unit.dp
import dev.optio.core.ui.components.GroupedSection
import dev.optio.core.ui.theme.OptioTheme
import dev.optio.core.ui.theme.Spacing
import dev.optio.core.ui.theme.tabularNums

// Form building blocks for the Job, scheduled-blueprint, subtask and trigger forms (iOS `Form` rows:
// TextField, Toggle, Stepper, Picker), in Material 3 dress on the grouped page.

/** A form section: [header], the fields on one card with room between them, and a [footer]. */
@Composable
fun FormSection(
    modifier: Modifier = Modifier,
    header: String? = null,
    footer: String? = null,
    content: @Composable ColumnScope.() -> Unit,
) {
    GroupedSection(modifier = modifier, header = header, footer = footer) {
        Column(
            Modifier.fillMaxWidth().padding(horizontal = Spacing.l, vertical = Spacing.m),
            verticalArrangement = Arrangement.spacedBy(Spacing.m),
            content = content,
        )
    }
}

/** A text field (iOS `TextField` / `TextEditor`); [mono] for templates, cron and paths. */
@Composable
fun FormTextField(
    value: String,
    onValueChange: (String) -> Unit,
    label: String,
    modifier: Modifier = Modifier,
    placeholder: String? = null,
    singleLine: Boolean = true,
    minLines: Int = 1,
    maxLines: Int = if (singleLine) 1 else 12,
    mono: Boolean = false,
    keyboardType: KeyboardType = KeyboardType.Text,
    capitalization: KeyboardCapitalization = KeyboardCapitalization.Sentences,
    supportingText: String? = null,
    isError: Boolean = false,
    enabled: Boolean = true,
    prefix: String? = null,
    testTag: String? = null,
) {
    val style = if (mono) OptioTheme.type.monoBody else OptioTheme.type.body
    OutlinedTextField(
        value = value,
        onValueChange = onValueChange,
        label = { Text(label) },
        placeholder = placeholder?.let { { Text(it, style = style) } },
        singleLine = singleLine,
        minLines = minLines,
        maxLines = maxLines,
        textStyle = style,
        keyboardOptions = KeyboardOptions(capitalization = capitalization, keyboardType = keyboardType, autoCorrectEnabled = !mono && keyboardType == KeyboardType.Text),
        supportingText = supportingText?.let { { Text(it) } },
        isError = isError,
        enabled = enabled,
        prefix = prefix?.let { { Text(it, style = OptioTheme.type.monoFootnote, color = OptioTheme.colors.secondaryLabel) } },
        modifier = modifier.fillMaxWidth().then(testTag?.let { Modifier.testTag(it) } ?: Modifier),
    )
}

/** A labelled switch row (iOS `Toggle`); the whole row toggles. */
@Composable
fun FormSwitch(
    label: String,
    checked: Boolean,
    onCheckedChange: (Boolean) -> Unit,
    modifier: Modifier = Modifier,
    detail: String? = null,
    enabled: Boolean = true,
    testTag: String? = null,
) {
    Row(
        modifier = modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, role = Role.Switch) { onCheckedChange(!checked) }
            .padding(vertical = 2.dp),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.m),
    ) {
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(2.dp)) {
            Text(label, style = OptioTheme.type.body, color = OptioTheme.colors.label)
            if (detail != null) Text(detail, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel)
        }
        Switch(
            checked = checked,
            onCheckedChange = onCheckedChange,
            enabled = enabled,
            modifier = testTag?.let { Modifier.testTag(it) } ?: Modifier,
        )
    }
}

/** A number with − / + buttons (iOS `Stepper("Max retries: 1", value:, in:)`). */
@Composable
fun FormStepper(
    label: String,
    value: Int,
    range: IntRange,
    onValueChange: (Int) -> Unit,
    modifier: Modifier = Modifier,
    step: Int = 1,
    testTag: String? = null,
) {
    Row(
        modifier = modifier.fillMaxWidth().then(testTag?.let { Modifier.testTag(it) } ?: Modifier),
        verticalAlignment = Alignment.CenterVertically,
        horizontalArrangement = Arrangement.spacedBy(Spacing.s),
    ) {
        Text(label, style = OptioTheme.type.body, color = OptioTheme.colors.label, modifier = Modifier.weight(1f))
        FilledTonalIconButton(onClick = { onValueChange((value - step).coerceIn(range)) }, enabled = value > range.first) {
            Icon(Icons.Filled.Remove, contentDescription = "Decrease $label")
        }
        Text(
            value.toString(),
            style = OptioTheme.type.headline.tabularNums(),
            color = OptioTheme.colors.label,
            modifier = Modifier.padding(horizontal = Spacing.xs),
        )
        FilledTonalIconButton(onClick = { onValueChange((value + step).coerceIn(range)) }, enabled = value < range.last) {
            Icon(Icons.Filled.Add, contentDescription = "Increase $label")
        }
    }
}

/** A menu picker (iOS `Picker(.menu)`): the chosen option's label in a read-only field. */
@Composable
fun <T> FormPicker(
    label: String,
    selection: T,
    options: List<Pair<T, String>>,
    onSelect: (T) -> Unit,
    modifier: Modifier = Modifier,
    mono: Boolean = false,
    enabled: Boolean = true,
    placeholder: String = "Select…",
    testTag: String? = null,
) {
    var expanded by remember { mutableStateOf(false) }
    val text = options.firstOrNull { it.first == selection }?.second ?: placeholder
    ExposedDropdownMenuBox(expanded = expanded, onExpandedChange = { if (enabled) expanded = it }, modifier = modifier) {
        OutlinedTextField(
            value = text,
            onValueChange = {},
            readOnly = true,
            enabled = enabled,
            label = { Text(label) },
            singleLine = true,
            textStyle = if (mono) OptioTheme.type.monoBody else OptioTheme.type.body,
            trailingIcon = { ExposedDropdownMenuDefaults.TrailingIcon(expanded = expanded) },
            modifier = Modifier
                .fillMaxWidth()
                .menuAnchor(ExposedDropdownMenuAnchorType.PrimaryNotEditable, enabled)
                .then(testTag?.let { Modifier.testTag(it) } ?: Modifier),
        )
        ExposedDropdownMenu(expanded = expanded, onDismissRequest = { expanded = false }) {
            options.forEach { (value, optionLabel) ->
                DropdownMenuItem(
                    text = { Text(optionLabel, style = if (mono) OptioTheme.type.monoBody else OptioTheme.type.body) },
                    onClick = {
                        expanded = false
                        onSelect(value)
                    },
                    contentPadding = ExposedDropdownMenuDefaults.ItemContentPadding,
                )
            }
        }
    }
}

/** Padding for a scrolling form: the scaffold's, plus room at the bottom. */
fun PaddingValues.formPadding(): PaddingValues = PaddingValues(
    top = calculateTopPadding(),
    bottom = calculateBottomPadding() + Spacing.xl,
)

/** A caption above a group of controls inside a section ("Detected parameters"). */
@Composable
fun FormCaption(text: String, modifier: Modifier = Modifier) {
    Text(text, style = OptioTheme.type.footnote, color = OptioTheme.colors.secondaryLabel, modifier = modifier)
}
