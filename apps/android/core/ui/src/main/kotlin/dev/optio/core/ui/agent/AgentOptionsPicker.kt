package dev.optio.core.ui.agent

import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.input.KeyboardCapitalization
import dev.optio.core.model.ModelProviderModel
import dev.optio.core.ui.components.agentIcon
import dev.optio.core.ui.form.MenuCaption
import dev.optio.core.ui.form.MenuChoice
import dev.optio.core.ui.form.MenuDivider
import dev.optio.core.ui.form.MenuRow
import dev.optio.core.ui.form.RowDivider
import dev.optio.core.ui.form.SwitchRow
import dev.optio.core.ui.form.ValueField

/** One choice of a [RuntimeMenuRow]: a runtime value ([TERMINAL] = no agent), and why it can't be picked, if it can't. */
data class RuntimeChoice(val value: String, val disabled: String? = null)

/** Every agent runtime, all pickable (a repo's default agent). */
val ALL_RUNTIME_CHOICES: List<RuntimeChoice> = RUNTIMES.map { RuntimeChoice(it.value) }

/** "Claude Code"; [emptyLabel] for [TERMINAL]. */
fun runtimeChoiceLabel(runtime: String, emptyLabel: String = "Terminal"): String =
    if (runtime == TERMINAL) emptyLabel else runtimeLabel(runtime)

/**
 * Pick an agent runtime (the web's `AgentChoice` grid, as a menu row): each choice with its logo,
 * a disabled one with its reason. The New work form's Who section and a repo's default agent both
 * use it, with [AgentOptionsPicker] under it.
 */
@Composable
fun RuntimeMenuRow(
    label: String,
    runtime: String,
    choices: List<RuntimeChoice>,
    onPick: (String) -> Unit,
    modifier: Modifier = Modifier,
    emptyLabel: String = "Terminal",
) {
    MenuRow(
        label = label,
        value = runtimeChoiceLabel(runtime, emptyLabel),
        leadingIcon = agentIcon(runtime),
        modifier = modifier,
    ) {
        choices.forEach { r ->
            MenuChoice(
                runtimeChoiceLabel(r.value, emptyLabel),
                selected = r.value == runtime,
                icon = agentIcon(r.value),
                enabled = r.disabled == null,
                subtitle = r.disabled,
                onClick = { onPick(r.value) },
            )
        }
    }
}

/**
 * Port of `agent-options-picker.tsx` as card rows (iOS `AgentOptionsPickerView`): the model (a
 * menu grouped by family, or a free-text field for OpenCode / OpenClaw and whenever the catalog
 * didn't load) plus the provider's options: selects as menu rows, booleans as switches, texts as
 * fields. A pod run gets every option; a run on a machine ([local]) only what the daemon hands the
 * agent CLI there: effort, and the permission mode (Claude Code's, or Codex's `--yolo`). Blank
 * means the runtime's default. A per-model effort field ([ProviderCatalog.Option.modelEfforts])
 * offers only the selected model's efforts, hides for a model that takes none, and is blanked when
 * the model changes to one that doesn't take it. Rows are separated by dividers; the first row
 * draws none (the caller's divider is above it).
 */
@Composable
fun AgentOptionsPicker(
    provider: String,
    state: CatalogState?,
    values: Map<String, OptionValue>,
    local: Boolean,
    onChange: (String, OptionValue) -> Unit,
    providerModels: List<ModelProviderModel>? = null,
) {
    val catalog = state.catalog
    val modelField = catalog?.modelField ?: modelFieldForProvider(provider)
    // A stored alias ("opus") shows as the model it resolves to, so the menu matches an option.
    val modelValue = resolveModel(values[modelField]?.stringValue.orEmpty(), catalog?.aliases)
    val pickModel: (String) -> Unit = { id ->
        onChange(modelField, OptionValue.Str(id))
        catalog?.effortResets(values, id)?.forEach { onChange(it, OptionValue.Str("")) }
    }

    if (providerModels != null) {
        // A model provider is picked: its own model ids (the first is its default); free text
        // when it lists none.
        val raw = values[modelField]?.stringValue.orEmpty()
        if (providerModels.isEmpty()) {
            ValueField(
                label = "Model",
                value = raw,
                onValueChange = { onChange(modelField, OptionValue.Str(it)) },
                placeholder = "Provider model id",
                capitalization = KeyboardCapitalization.None,
                fieldTag = "option-$modelField",
            )
        } else {
            MenuRow(label = "Model", value = providerModels.firstOrNull { it.id == raw }?.let { it.label ?: it.id } ?: raw.ifEmpty { "Pick a model…" }) {
                if (raw.isNotEmpty() && providerModels.none { it.id == raw }) MenuChoice(raw, selected = true, onClick = {})
                providerModels.forEach { m ->
                    MenuChoice(m.label ?: m.id, selected = m.id == raw, subtitle = m.id.takeIf { m.label != null }, mono = false, onClick = { onChange(modelField, OptionValue.Str(m.id)) })
                }
            }
        }
    } else if (catalog != null && catalog.modelIsFreeText != true) {
        MenuRow(label = "Model", value = modelLabel(catalog, modelValue), modifier = Modifier.testTag("option-$modelField")) {
            MenuChoice("Default", selected = modelValue.isEmpty(), onClick = { pickModel("") })
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
                    MenuChoice(m.displayLabel, selected = m.id == modelValue, onClick = { pickModel(m.id) })
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
    // A provider's model list replaces the catalog's: its ids carry no per-model efforts.
    val selectedModel = if (providerModels == null) catalog.models.firstOrNull { it.id == modelValue } else null

    fields.filter { it.kind == "select" }.forEach { field ->
        val choices = optionChoicesFor(field, selectedModel)
        // A model without that setting (Claude Haiku 4.5 takes no effort): no field.
        if (field.modelEfforts == true && choices.isEmpty()) return@forEach
        RowDivider()
        // On a machine a field pods share (effort) has no default of its own: unset leaves the
        // machine's config, so the menu offers "Default".
        val fieldDefault = if (local && field.appliesToPods) "" else field.defaultString
        val current = values[field.key]?.stringValue ?: fieldDefault
        // Blank means the CLI's default — for effort per model, the model's own.
        val modelDefault = if (field.modelEfforts == true) selectedModel?.defaultEffort else null
        val defaultLabel = modelDefault?.let { d -> "Default (${choices.firstOrNull { it.value == d }?.label ?: d})" } ?: "Default"
        MenuRow(
            label = field.label,
            value = choices.firstOrNull { it.value == current }?.label ?: current.ifEmpty { defaultLabel },
            modifier = Modifier.testTag("option-${field.key}"),
        ) {
            if (fieldDefault.isEmpty() || current.isEmpty()) {
                MenuChoice(defaultLabel, selected = current.isEmpty(), onClick = { onChange(field.key, OptionValue.Str("")) })
            }
            if (current.isNotEmpty() && choices.none { it.value == current }) {
                MenuChoice(current, selected = true, onClick = {})
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
