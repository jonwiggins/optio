package dev.optio.feature.workform

import androidx.compose.runtime.Composable
import androidx.compose.ui.text.input.KeyboardCapitalization

/**
 * Port of `agent-options-picker.tsx` as card rows (iOS `AgentOptionsPickerView`): the model (a
 * menu grouped by family, or a free-text field for OpenCode / OpenClaw and whenever the catalog
 * didn't load) plus the provider's options: selects as menu rows, booleans as switches, texts as
 * fields. A pod run gets every option; a run on a machine ([local]) only what the daemon hands the
 * agent CLI there: effort, and the permission mode (Claude Code's, or Codex's `--yolo`). Blank
 * means the runtime's default. Rows are separated by dividers; the first row draws none (the
 * caller's divider is above it).
 */
@Composable
internal fun AgentOptionsPicker(
    provider: String,
    state: CatalogState?,
    values: Map<String, OptionValue>,
    local: Boolean,
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
    if (catalog == null) return
    val fields = catalog.options.filter { if (local) it.appliesToLocal else it.appliesToPods }

    fields.filter { it.kind == "select" }.forEach { field ->
        RowDivider()
        // On a machine a field pods share (effort) has no default of its own: unset leaves the
        // machine's config, so the menu offers "Default".
        val fieldDefault = if (local && field.appliesToPods) "" else field.defaultString
        val current = values[field.key]?.stringValue ?: fieldDefault
        val choices = field.choices.orEmpty()
        MenuRow(
            label = field.label,
            value = choices.firstOrNull { it.value == current }?.label ?: current.ifEmpty { "Default" },
        ) {
            if (fieldDefault.isEmpty()) {
                MenuChoice("Default", selected = current.isEmpty(), onClick = { onChange(field.key, OptionValue.Str("")) })
            }
            choices.forEach { c ->
                MenuChoice(c.label, selected = c.value == current, subtitle = c.description, onClick = { onChange(field.key, OptionValue.Str(c.value)) })
            }
        }
    }
    fields.filter { it.kind == "boolean" }.forEach { field ->
        RowDivider()
        SwitchRow(
            title = field.label,
            subtitle = field.helpText,
            checked = values[field.key]?.boolValue ?: field.defaultBool,
            onCheckedChange = { onChange(field.key, OptionValue.Bool(it)) },
        )
    }
    fields.filter { it.kind == "text" }.forEach { field ->
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
