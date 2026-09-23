package dev.optio.feature.workform

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardCapitalization

/**
 * Port of `agent-options-picker.tsx` as card rows (iOS `AgentOptionsPickerView`): the model (a
 * menu grouped by family, or a free-text field for OpenCode / OpenClaw and whenever the catalog
 * didn't load) plus, unless [modelOnly], every provider option: selects as menu rows, booleans as
 * switches, texts as fields. Blank means the runtime's default. Rows are separated by dividers;
 * the first row draws none (the caller's divider is above it).
 */
@Composable
internal fun AgentOptionsPicker(
    provider: String,
    state: CatalogState?,
    values: Map<String, OptionValue>,
    modelOnly: Boolean,
    onChange: (String, OptionValue) -> Unit,
) {
    val catalog = state.catalog
    val modelField = catalog?.modelField ?: modelFieldForProvider(provider)
    // A stored alias ("opus") shows as the model it resolves to, so the menu matches an option.
    val modelValue = resolveModel(values[modelField]?.stringValue.orEmpty(), catalog?.aliases)

    if (catalog != null && catalog.modelIsFreeText != true) {
        MenuRow(label = "Model", value = modelLabel(catalog, modelValue)) {
            MenuChoice("Default", selected = modelValue.isEmpty(), onClick = { onChange(modelField, OptionValue.Str("")) })
            if (modelValue.isNotEmpty() && catalog.models.none { it.id == modelValue }) {
                MenuChoice(modelValue, selected = true, onClick = {})
            }
            val families = catalog.families
            families.forEach { (family, models) ->
                if (families.size > 1) {
                    MenuDivider()
                    MenuCaption(family.replaceFirstChar { it.uppercase() })
                }
                models.forEach { m ->
                    MenuChoice(m.displayLabel, selected = m.id == modelValue, onClick = { onChange(modelField, OptionValue.Str(m.id)) })
                }
            }
        }
    } else {
        ValueField(
            label = "Model",
            value = modelValue,
            onValueChange = { onChange(modelField, OptionValue.Str(it)) },
            placeholder = if (state is CatalogState.Loading) "Loading…" else catalog?.modelPlaceholder ?: "Default",
            fieldTag = "option-$modelField",
        )
    }
    if (modelOnly || catalog == null) return

    catalog.options.filter { it.kind == "select" }.forEach { field ->
        RowDivider()
        val current = values[field.key]?.stringValue ?: field.defaultString
        val choices = field.choices.orEmpty()
        MenuRow(
            label = field.label,
            value = choices.firstOrNull { it.value == current }?.label ?: current.ifEmpty { "Default" },
        ) {
            choices.forEach { c ->
                MenuChoice(c.label, selected = c.value == current, subtitle = c.description, onClick = { onChange(field.key, OptionValue.Str(c.value)) })
            }
        }
    }
    catalog.options.filter { it.kind == "boolean" }.forEach { field ->
        RowDivider()
        SwitchRow(
            title = field.label,
            subtitle = field.helpText,
            checked = values[field.key]?.boolValue ?: field.defaultBool,
            onCheckedChange = { onChange(field.key, OptionValue.Bool(it)) },
        )
    }
    catalog.options.filter { it.kind == "text" }.forEach { field ->
        RowDivider()
        ValueField(
            label = field.label,
            value = values[field.key]?.stringValue.orEmpty(),
            onValueChange = { onChange(field.key, OptionValue.Str(it)) },
            placeholder = field.placeholder ?: "Default",
            capitalization = KeyboardCapitalization.None,
            fieldTag = "option-${field.key}",
        )
    }
}

private fun modelLabel(catalog: ProviderCatalog, modelValue: String): String {
    if (modelValue.isEmpty()) return "Default"
    return catalog.models.firstOrNull { it.id == modelValue }?.displayLabel ?: modelValue
}
