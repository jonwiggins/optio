import SwiftUI

struct PromptDetailView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @Environment(\.dismiss) private var dismiss
    @State var template: PromptTemplateRow
    var onChanged: () async -> Void

    @State private var showEditor = false
    @State private var showDeleteConfirm = false
    @State private var params: [String: String] = [:]
    @State private var extraParams = ""
    @State private var rendered: String?
    @State private var rendering = false
    @State private var errorMessage: String?

    var body: some View {
        List {
            Section {
                MoreInfoRow(label: "Kind", value: PromptKind.label(for: template.kind))
                if let agent = template.defaultAgentType, !agent.isEmpty {
                    MoreInfoRow(label: "Default agent", value: MoreAgentTypes.label(agent))
                }
                if let d = template.description, !d.isEmpty {
                    Text(d).font(.footnote).foregroundStyle(.secondary)
                }
                if let updated = template.updatedAt {
                    MoreInfoRow(label: "Updated", value: updated.relativeDescription)
                }
            }

            Section("Template body") {
                MoreCodeBlock(text: template.template ?? "")
                    .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
            }

            Section {
                let names = template.paramNames
                if names.isEmpty {
                    Text("No {{param}} placeholders detected. Add extra params below as key=value lines.")
                        .font(.footnote).foregroundStyle(.secondary)
                } else {
                    ForEach(names, id: \.self) { name in
                        HStack {
                            Text(name).font(.footnote.monospaced())
                            TextField("value", text: Binding(
                                get: { params[name] ?? "" },
                                set: { params[name] = $0 }
                            ))
                            .multilineTextAlignment(.trailing)
                            .autocorrectionDisabled()
                        }
                    }
                }
                TextField("extra=value (one per line)", text: $extraParams, axis: .vertical)
                    .font(.footnote.monospaced())
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                if context.isMember {
                    Button {
                        Task { await preview() }
                    } label: {
                        if rendering { ProgressView() } else { Label("Render preview", systemImage: "eye") }
                    }
                    .disabled(rendering)
                }
            } header: {
                Text("Preview with params")
            }

            if let rendered {
                Section("Rendered") {
                    MoreCodeBlock(text: rendered)
                        .listRowInsets(EdgeInsets(top: 8, leading: 12, bottom: 8, trailing: 12))
                }
            }

            if context.isMember {
                Section {
                    Button(role: .destructive) { showDeleteConfirm = true } label: {
                        Label("Delete template", systemImage: "trash")
                    }
                }
            }
        }
        .navigationTitle(template.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if context.isMember {
                ToolbarItem(placement: .primaryAction) {
                    Button("Edit") { showEditor = true }
                }
            }
        }
        .sheet(isPresented: $showEditor) {
            PromptEditorSheet(template: template) {
                if let fresh = try? await api.listPromptTemplates().first(where: { $0.id == template.id }) {
                    template = fresh
                }
                await onChanged()
            }
        }
        .confirmationDialog("Delete \"\(template.name)\"?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                Task {
                    do {
                        try await api.deletePromptTemplate(template.id)
                        await onChanged()
                        dismiss()
                    } catch {
                        errorMessage = error.moreDescription
                    }
                }
            }
        }
        .moreErrorAlert($errorMessage)
    }

    private func preview() async {
        rendering = true
        defer { rendering = false }
        var all = params.filter { !$0.value.isEmpty }
        for line in extraParams.split(separator: "\n") {
            let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
            if parts.count == 2, !parts[0].isEmpty { all[parts[0]] = parts[1] }
        }
        do {
            rendered = try await api.previewPromptTemplate(template.id, params: all)
        } catch {
            errorMessage = error.moreDescription
        }
    }
}

/// Create or edit a named template. Mirrors the web's TemplateEditor.
struct PromptEditorSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let template: PromptTemplateRow?
    var onSaved: () async -> Void

    @State private var name = ""
    @State private var kind: PromptKind = .prompt
    @State private var description = ""
    @State private var defaultAgentType = ""
    @State private var body_ = ""
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    Picker("Kind", selection: $kind) {
                        ForEach(PromptKind.allCases) { Text($0.label).tag($0) }
                    }
                    TextField("Description", text: $description, axis: .vertical)
                    Picker("Default agent", selection: $defaultAgentType) {
                        Text("None").tag("")
                        ForEach(MoreAgentTypes.all, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Section {
                    TextEditor(text: $body_)
                        .font(.footnote.monospaced())
                        .frame(minHeight: 220)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                } header: {
                    Text("Template body")
                } footer: {
                    Text("Use {{param}} for substitution and {{#if flag}}…{{/if}} for conditionals.")
                }
            }
            .navigationTitle(template == nil ? "New Template" : "Edit Template")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty || body_.isEmpty)
                }
            }
            .onAppear {
                guard let t = template else { return }
                name = t.name
                kind = PromptKind(rawValue: t.kind ?? "") ?? .prompt
                description = t.description ?? ""
                defaultAgentType = t.defaultAgentType ?? ""
                body_ = t.template ?? ""
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let input = PromptTemplateInput(
            name: name.trimmingCharacters(in: .whitespaces),
            template: body_,
            kind: kind.rawValue,
            description: description.isEmpty ? nil : description,
            defaultAgentType: defaultAgentType.isEmpty ? nil : defaultAgentType
        )
        do {
            if let t = template {
                _ = try await api.updatePromptTemplate(t.id, input)
            } else {
                _ = try await api.createPromptTemplate(input)
            }
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
