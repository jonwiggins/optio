import SwiftUI

/// Port of `agent-options-picker.tsx` as Form rows: the model (a menu grouped
/// by family, or a free-text field for OpenCode / OpenClaw and whenever the
/// catalog didn't load) plus, when `modelOnly` is false, every provider
/// option — selects as menu rows, booleans as toggles, texts as fields. Blank
/// means the runtime's default.
struct AgentOptionsPickerView: View {
    let provider: String
    let state: AgentCatalogStore.State?
    let values: SessionForm.AgentOptions
    let modelOnly: Bool
    let onChange: (String, SessionForm.OptionValue) -> Void

    private var catalog: ProviderCatalog? { if case .loaded(let c) = state { return c } else { return nil } }
    private var modelField: String { catalog?.modelField ?? SessionForm.modelField(forProvider: provider) }
    /// A stored alias ("opus") shows as the model it resolves to, so the menu
    /// matches an option instead of silently displaying the first one.
    private var loading: Bool { if case .loading = state { return true } else { return false } }
    private var modelValue: String { SessionForm.resolveModel(values[modelField]?.stringValue ?? "", aliases: catalog?.aliases) }

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
        if !modelOnly, let catalog {
            ForEach(catalog.options.filter { $0.kind == "select" }) { field in selectRow(field) }
            ForEach(catalog.options.filter { $0.kind == "boolean" }) { field in
                Toggle(isOn: Binding(get: { values[field.key]?.boolValue ?? field.defaultBool }, set: { onChange(field.key, .bool($0)) })) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(field.label)
                        if let help = field.helpText { Text(help).font(.footnote).foregroundStyle(.secondary) }
                    }
                }
            }
            ForEach(catalog.options.filter { $0.kind == "text" }) { field in
                ValueField(label: field.label, placeholder: field.placeholder ?? "Default",
                           text: Binding(get: { values[field.key]?.stringValue ?? "" }, set: { onChange(field.key, .string($0)) }))
            }
        }
    }

    @ViewBuilder
    private var modelRow: some View {
        if let catalog, catalog.modelIsFreeText != true {
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
        let current = values[field.key]?.stringValue ?? field.defaultString
        let choices = field.choices ?? []
        return MenuRow(label: field.label, value: choices.first { $0.value == current }?.label ?? (current.isEmpty ? "Default" : current)) {
            ForEach(choices) { c in
                MenuChoice(title: c.label, subtitle: c.description, selected: c.value == current) { onChange(field.key, .string(c.value)) }
            }
        }
    }
}
