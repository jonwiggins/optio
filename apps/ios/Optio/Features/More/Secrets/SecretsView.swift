import SwiftUI
import Observation

@Observable
@MainActor
final class SecretsModel {
    var secrets: [SecretRow] = []
    var repos: [RepoRow] = []
    var scopeFilter = "all"
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = secrets.isEmpty
        defer { loading = false }
        async let repoList = api.listRepos()
        do {
            secrets = try await api.listSecrets(scope: scopeFilter == "all" ? nil : scopeFilter)
            error = nil
        } catch {
            self.error = error
        }
        repos = (try? await repoList) ?? []
    }

    func scopeLabel(_ scope: String?) -> String {
        switch scope {
        case nil, "global": return "Global"
        case "user": return "User-only"
        default: return repos.first { $0.repoUrl == scope }?.fullName ?? (scope ?? "")
        }
    }
}

/// Secret names and scopes only. Values are write-only: never fetched, shown, or logged.
struct SecretsView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = SecretsModel()
    @State private var showForm = false
    @State private var pendingDelete: SecretRow?
    @State private var errorMessage: String?
    @State private var notice: String?

    var body: some View {
        List {
            Section {
                Picker("Scope", selection: $model.scopeFilter) {
                    Text("All scopes").tag("all")
                    Text("Global only").tag("global")
                    Text("User-only").tag("user")
                    ForEach(model.repos) { repo in
                        if let url = repo.repoUrl { Text(repo.displayName).tag(url) }
                    }
                }
                .onChange(of: model.scopeFilter) { _, _ in Task { await model.load(api: api) } }
            }
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.secrets.isEmpty {
                ErrorRow(error: error) { Task { await model.load(api: api) } }
            } else if model.secrets.isEmpty {
                EmptyState(title: "No secrets", systemImage: "key",
                           message: "Add API keys for Claude Code, Codex, or GitHub to get started.")
            } else {
                Section {
                    ForEach(model.secrets, id: \.listId) { s in
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(s.name).font(.body.monospaced())
                                if let u = s.updatedAt ?? s.createdAt {
                                    Text("Updated \(u.relativeDescription)").font(.caption2).foregroundStyle(.tertiary)
                                }
                            }
                            Spacer()
                            Label(model.scopeLabel(s.scope), systemImage: scopeIcon(s.scope))
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .swipeActions(edge: .trailing) {
                            if context.isAdmin || s.scope == "user" {
                                Button(role: .destructive) { pendingDelete = s } label: { Label("Delete", systemImage: "trash") }
                            }
                        }
                    }
                } footer: {
                    if model.secrets.contains(where: { $0.scope == "user" }) {
                        Text("User-only secrets are scoped to you and are not visible to background runs (ticket sync, schedules, webhooks). Store a credential as Global to make it available everywhere.")
                    } else {
                        Text("Values are encrypted at rest and never returned by the API.")
                    }
                }
            }
        }
        .navigationTitle("Secrets")
        .toolbar {
            if context.isMember {
                ToolbarItem(placement: .primaryAction) {
                    Button { showForm = true } label: { Image(systemName: "plus") }
                }
            }
        }
        .task { await model.load(api: api) }
        .refreshable { await model.load(api: api) }
        .sheet(isPresented: $showForm) {
            SecretFormSheet(repos: model.repos, allowGlobal: context.isAdmin) { result in
                await model.load(api: api)
                if let v = result.validation, !v.valid {
                    notice = "Saved, but validation failed: \(v.error ?? "token rejected")"
                } else {
                    notice = "\(result.name) has been encrypted and stored."
                }
            }
        }
        .confirmationDialog("Delete secret \(pendingDelete?.name ?? "")?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let s = pendingDelete else { return }
                Task {
                    do {
                        try await api.deleteSecret(name: s.name, scope: s.scope)
                        await model.load(api: api)
                    } catch { errorMessage = error.moreDescription }
                }
            }
        }
        .toast(notice, tone: .success) { notice = nil }
        .moreErrorAlert($errorMessage)
    }

    private func scopeIcon(_ scope: String?) -> String {
        switch scope {
        case nil, "global": return "globe"
        case "user": return "person"
        default: return "folder"
        }
    }
}

/// Create or update a secret by name. The value field is a secure entry and is
/// discarded as soon as the request completes.
struct SecretFormSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let repos: [RepoRow]
    let allowGlobal: Bool
    var onSaved: (SecretCreateResult) async -> Void

    @State private var name = ""
    @State private var value = ""
    @State private var scope = "global"
    @State private var saving = false
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ANTHROPIC_API_KEY", text: $name)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.characters)
                    SecureField("Value", text: $value)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Picker("Scope", selection: $scope) {
                        if allowGlobal { Text("Global (all repos)").tag("global") }
                        Text("User-only (just me)").tag("user")
                        if allowGlobal {
                            ForEach(repos) { repo in
                                if let url = repo.repoUrl { Text(repo.displayName).tag(url) }
                            }
                        }
                    }
                } footer: {
                    Text("Saving an existing name replaces its value. Auth tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN) are validated after saving.")
                }
            }
            .navigationTitle("Add Secret")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { if !allowGlobal { scope = "user" } }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: {
                        if saving { ProgressView() } else { Text("Save") }
                    }
                    .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty || value.isEmpty)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            let result = try await api.upsertSecret(name: name.trimmingCharacters(in: .whitespaces), value: value, scope: scope)
            value = ""
            await onSaved(result)
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
