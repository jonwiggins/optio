import SwiftUI

/// Port of `agent-options-picker.tsx`: the model control (grouped menu, or a
/// free-text field for OpenCode / OpenClaw and whenever the catalog didn't
/// load) plus, when `modelOnly` is false, every provider option: selects as
/// menus, booleans as toggles, texts as fields. Blank means the runtime's default.
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
    private var modelValue: String { SessionForm.resolveModel(values[modelField]?.stringValue ?? "", aliases: catalog?.aliases) }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            modelControl
            if !modelOnly, let catalog {
                ForEach(catalog.options.filter { $0.kind == "select" }) { field in selectRow(field) }
                ForEach(catalog.options.filter { $0.kind == "boolean" }) { field in
                    Toggle(isOn: Binding(get: { values[field.key]?.boolValue ?? field.defaultBool }, set: { onChange(field.key, .bool($0)) })) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(field.label).font(.subheadline)
                            if let help = field.helpText { Text(help).font(.caption).foregroundStyle(.tertiary) }
                        }
                    }
                    .tint(AppTheme.accent)
                }
                ForEach(catalog.options.filter { $0.kind == "text" }) { field in
                    VStack(alignment: .leading, spacing: Spacing.xs) {
                        FieldLabel(text: field.label)
                        CardTextField(placeholder: field.placeholder ?? "", text: Binding(get: { values[field.key]?.stringValue ?? "" }, set: { onChange(field.key, .string($0)) }), mono: true)
                        if let help = field.helpText { Hint(text: help) }
                    }
                }
            }
            if case .failed(let why) = state {
                Hint(text: "Model list unavailable — type a model id. (\(why))", tone: .accent)
            }
        }
    }

    @ViewBuilder
    private var modelControl: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            FieldLabel(text: "Model")
            if let catalog, catalog.modelIsFreeText != true {
                Menu {
                    Button { onChange(modelField, .string("")) } label: {
                        if modelValue.isEmpty { Label("Default", systemImage: "checkmark") } else { Text("Default") }
                    }
                    ForEach(catalog.families, id: \.family) { group in
                        if catalog.families.count == 1 {
                            ForEach(group.models) { m in modelButton(m) }
                        } else {
                            Section(group.family.capitalized) { ForEach(group.models) { m in modelButton(m) } }
                        }
                    }
                } label: {
                    HStack {
                        Text(modelLabel(catalog)).foregroundStyle(modelValue.isEmpty ? .secondary : .primary)
                        Spacer()
                        Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                    }
                    .padding(.horizontal, Spacing.m).padding(.vertical, 9)
                    .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
                    .contentShape(Radius.smallShape)
                }
                .buttonStyle(.plain)
            } else {
                CardTextField(placeholder: catalog?.modelPlaceholder ?? "Default", text: Binding(get: { modelValue }, set: { onChange(modelField, .string($0)) }), mono: true)
                if let help = catalog?.modelHelpText { Hint(text: help) }
                if case .loading = state { Hint(text: "Loading models…") }
            }
        }
    }

    private func modelButton(_ m: ProviderCatalog.Model) -> some View {
        Button { onChange(modelField, .string(m.id)) } label: {
            if m.id == modelValue { Label(m.displayLabel, systemImage: "checkmark") } else { Text(m.displayLabel) }
        }
    }

    private func modelLabel(_ catalog: ProviderCatalog) -> String {
        if modelValue.isEmpty { return "Default" }
        return catalog.models.first { $0.id == modelValue }?.displayLabel ?? modelValue
    }

    private func selectRow(_ field: ProviderCatalog.Option) -> some View {
        let current = values[field.key]?.stringValue ?? field.defaultString
        return VStack(alignment: .leading, spacing: Spacing.xs) {
            FieldLabel(text: field.label)
            Menu {
                ForEach(field.choices ?? []) { c in
                    Button { onChange(field.key, .string(c.value)) } label: {
                        if c.value == current { Label(c.label, systemImage: "checkmark") } else { Text(c.label) }
                        if let d = c.description { Text(d) }
                    }
                }
            } label: {
                HStack {
                    Text((field.choices ?? []).first { $0.value == current }?.label ?? (current.isEmpty ? "Default" : current))
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down").font(.caption).foregroundStyle(.secondary)
                }
                .padding(.horizontal, Spacing.m).padding(.vertical, 9)
                .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
                .contentShape(Radius.smallShape)
            }
            .buttonStyle(.plain)
            if let help = field.helpText { Hint(text: help) }
        }
    }
}
