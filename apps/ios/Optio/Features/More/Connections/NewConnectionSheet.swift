import SwiftUI

/// Create a connection for a provider. Config fields come from the provider's
/// JSON-Schema `configSchema`; `format: "secret"` fields use SecureField and
/// their values live only in this sheet until the request is sent.
struct NewConnectionSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let provider: ConnectionProviderRow
    let repos: [RepoRow]
    var onCreated: () async -> Void

    @State private var name = ""
    @State private var config: [String: String] = [:]
    @State private var revealed: Set<String> = []
    @State private var showAccess = false
    @State private var repoId = ""
    @State private var agentTypes: Set<String> = []
    @State private var permission = "read"
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    HStack(spacing: 10) {
                        Image(systemName: ConnectionIcons.symbol(for: provider)).foregroundStyle(AppTheme.accent)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(provider.name ?? provider.slug ?? "").font(.headline)
                            if let d = provider.description {
                                Text(d).font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                    TextField("Connection name", text: $name)
                }

                let fields = provider.configFields
                if !fields.isEmpty {
                    Section("Configuration") {
                        ForEach(fields) { field in
                            VStack(alignment: .leading, spacing: 4) {
                                HStack(spacing: 2) {
                                    Text(field.title).font(.caption).foregroundStyle(.secondary)
                                    if field.required { Text("*").font(.caption).foregroundStyle(.red) }
                                }
                                HStack {
                                    if field.isSecret && !revealed.contains(field.key) {
                                        SecureField(field.placeholder ?? "", text: binding(field.key))
                                    } else {
                                        TextField(field.placeholder ?? "", text: binding(field.key))
                                    }
                                    if field.isSecret {
                                        Button {
                                            if revealed.contains(field.key) { revealed.remove(field.key) } else { revealed.insert(field.key) }
                                        } label: {
                                            Image(systemName: revealed.contains(field.key) ? "eye.slash" : "eye")
                                        }
                                        .buttonStyle(.borderless)
                                    }
                                }
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                            }
                        }
                    }
                }

                if let secrets = provider.requiredSecrets, !secrets.isEmpty {
                    Section("Required secrets") {
                        MoreChipCloud(items: secrets)
                        Text("These must exist under Secrets for agents to use this connection.")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                }

                Section {
                    DisclosureGroup("Access control", isExpanded: $showAccess) {
                        AccessControlFields(repos: repos, repoId: $repoId, agentTypes: $agentTypes, permission: $permission)
                    }
                } footer: {
                    Text(showAccess ? "Leave all agent toggles off to allow every agent type." : "Defaults: all repos · all agents · read only")
                }
            }
            .navigationTitle("Add Connection")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { if name.isEmpty, let n = provider.name { name = "My \(n)" } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Add") }
                    }
                    .disabled(saving || !canSave)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private var canSave: Bool {
        guard !name.trimmingCharacters(in: .whitespaces).isEmpty else { return false }
        return provider.configFields.filter(\.required).allSatisfy { !(config[$0.key] ?? "").isEmpty }
    }

    private func binding(_ key: String) -> Binding<String> {
        Binding(get: { config[key] ?? "" }, set: { config[key] = $0 })
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            _ = try await api.createConnection(ConnectionCreateInput(
                providerId: provider.id,
                name: name.trimmingCharacters(in: .whitespaces),
                config: config.filter { !$0.value.isEmpty },
                assignments: [.init(
                    repoId: repoId.isEmpty ? nil : repoId,
                    agentTypes: MoreAgentTypes.all.map(\.0).filter { agentTypes.contains($0) },
                    permission: permission
                )]
            ))
            config = [:]
            await onCreated()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
