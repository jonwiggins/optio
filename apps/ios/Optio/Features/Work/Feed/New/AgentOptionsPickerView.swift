import SwiftUI

/// Port of `agent-options-picker.tsx` as Form rows: the model (a menu grouped
/// by family, or a free-text field for OpenCode / OpenClaw and whenever the
/// catalog didn't load) plus the provider's options — selects as menu rows,
/// booleans as toggles, texts as fields. A pod run gets every option; a run on
/// a machine (`local`) only what the daemon hands the agent CLI there: effort,
/// and the permission mode (Claude Code's, or Codex's `--yolo`). Blank means
/// the runtime's default.
struct AgentOptionsPickerView: View {
    let provider: String
    let state: AgentCatalogStore.State?
    let values: WorkForm.AgentOptions
    let local: Bool
    /// A picked model provider's models: the model row lists these instead of the catalog's.
    var providerModels: [ModelProviderModel]? = nil
    let onChange: (String, WorkForm.OptionValue) -> Void

    private var catalog: ProviderCatalog? { if case .loaded(let c) = state { return c } else { return nil } }
    private var modelField: String { catalog?.modelField ?? WorkForm.modelField(forProvider: provider) }
    /// A stored alias ("opus") shows as the model it resolves to, so the menu
    /// matches an option instead of silently displaying the first one.
    private var loading: Bool { if case .loading = state { return true } else { return false } }
    private var modelValue: String { WorkForm.resolveModel(values[modelField]?.stringValue ?? "", aliases: catalog?.aliases) }

    /// What the owning section's footer should add: why the model list is a text field.
    static func footnote(_ state: AgentCatalogStore.State?) -> String? {
        switch state {
        case .failed(let why): return "Model list unavailable — type a model id. (\(why))"
        case .loaded(let c) where c.modelIsFreeText == true: return c.modelHelpText
        default: return nil
        }
    }

    var body: some View {
        modelRow
        if let catalog {
            let fields = catalog.options.filter { local ? $0.appliesToLocal : $0.appliesToPods }
            ForEach(fields.filter { $0.kind == "select" }) { field in selectRow(field) }
            ForEach(fields.filter { $0.kind == "boolean" }) { field in
                Toggle(isOn: Binding(get: { values[field.key]?.boolValue ?? field.defaultBool }, set: { onChange(field.key, .bool($0)) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.label)
                        if let help = field.helpText { Text(help).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            }
            ForEach(fields.filter { $0.kind == "text" }) { field in
                ValueField(label: field.label, placeholder: field.placeholder ?? "Default",
                           text: Binding(get: { values[field.key]?.stringValue ?? "" }, set: { onChange(field.key, .string($0)) }))
            }
        }
    }

    @ViewBuilder
    private var modelRow: some View {
        if let providerModels {
            let raw = values[modelField]?.stringValue ?? ""
            if providerModels.isEmpty {
                ValueField(label: "Model", placeholder: "Provider model id",
                           text: Binding(get: { raw }, set: { onChange(modelField, .string($0)) }))
            } else {
                MenuRow(label: "Model", value: providerModels.first { $0.id == raw }?.label ?? (raw.isEmpty ? "Pick a model…" : raw), placeholder: raw.isEmpty) {
                    ForEach(providerModels, id: \.id) { m in
                        MenuChoice(title: m.label ?? m.id, subtitle: m.label == nil ? nil : m.id, selected: m.id == raw) { onChange(modelField, .string(m.id)) }
                    }
                }
            }
        } else if let catalog, catalog.modelIsFreeText != true {
            MenuRow(label: "Model", value: modelLabel(catalog)) {
                MenuChoice(title: "Default", selected: modelValue.isEmpty) { onChange(modelField, .string("")) }
                if !modelValue.isEmpty, !catalog.models.contains(where: { $0.id == modelValue }) {
                    MenuChoice(title: modelValue, selected: true) {}
                }
                ForEach(catalog.families, id: \.family) { group in
                    if catalog.families.count == 1 {
                        ForEach(group.models) { m in modelChoice(m) }
                    } else {
                        Section(group.family.capitalized) { ForEach(group.models) { m in modelChoice(m) } }
                    }
                }
            }
        } else {
            ValueField(label: "Model", placeholder: loading ? "Loading…" : (catalog?.modelPlaceholder ?? "Default"),
                       text: Binding(get: { modelValue }, set: { onChange(modelField, .string($0)) }))
        }
    }

    private func modelChoice(_ m: ProviderCatalog.Model) -> some View {
        MenuChoice(title: m.displayLabel, selected: m.id == modelValue) { onChange(modelField, .string(m.id)) }
    }

    private func modelLabel(_ catalog: ProviderCatalog) -> String {
        if modelValue.isEmpty { return "Default" }
        return catalog.models.first { $0.id == modelValue }?.displayLabel ?? modelValue
    }

    private func selectRow(_ field: ProviderCatalog.Option) -> some View {
        // On a machine a field pods share (effort) has no default of its own:
        // unset leaves the machine's config, so the menu offers "Default".
        let fieldDefault = local && field.appliesToPods ? "" : field.defaultString
        let current = values[field.key]?.stringValue ?? fieldDefault
        let choices = field.choices ?? []
        return MenuRow(label: field.label, value: choices.first { $0.value == current }?.label ?? (current.isEmpty ? "Default" : current)) {
            if fieldDefault.isEmpty {
                MenuChoice(title: "Default", selected: current.isEmpty) { onChange(field.key, .string("")) }
            }
            ForEach(choices) { c in
                MenuChoice(title: c.label, subtitle: c.description, selected: c.value == current) { onChange(field.key, .string(c.value)) }
            }
        }
    }
}
