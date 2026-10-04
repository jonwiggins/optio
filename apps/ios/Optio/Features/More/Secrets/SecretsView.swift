import SwiftUI
import Observation

@Observable
@MainActor
final class SecretsModel {
    var secrets: [SecretRow] = []
    var repos: [RepoRow] = []
    var loading = false
    var error: Error?

    func load(api: APIClient) async {
        loading = secrets.isEmpty
        defer { loading = false }
        async let repoList = api.listRepos()
        do {
            secrets = try await api.listSecrets()
            error = nil
        } catch {
            self.error = error
        }
        repos = (try? await repoList) ?? []
    }

    /// Where an organization secret applies: every repo, or one.
    func repoLabel(_ scope: String?) -> String {
        switch scope {
        case nil, "global": return "All repos"
        default: return repos.first { $0.repoUrl == scope }?.displayName ?? (scope ?? "")
        }
    }

    /// The organization's (instance-wide and per repo), the viewer's private
    /// ones and — for an admin — other people's, by name.
    func groups(viewerId: String?, isAdmin: Bool) -> ScopeGroups<SecretRow> {
        ScopeGroups.group(secrets, viewerId: viewerId, isAdmin: isAdmin) { s in
            // An older server may send a private row without saying whose: it's the viewer's.
            s.owner ?? (s.isPrivate ? (viewerId ?? "me") : nil)
        }
    }
}

/// Secret names and scopes only. Values are write-only: never fetched, shown, or logged.
///
/// Grouped by scope: the organization's (every repo, or one repo's), the
/// viewer's private ones, and — for an admin — other people's private ones by
/// name, read-only (deleting one is for offboarding).
struct SecretsView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var model = SecretsModel()
    @State private var showForm = false
    @State private var pendingDelete: SecretRow?
    @State private var errorMessage: String?
    @State private var notice: String?

    private var groups: ScopeGroups<SecretRow> { model.groups(viewerId: context.userId, isAdmin: context.isAdmin) }

    var body: some View {
        List {
            if model.loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let error = model.error, model.secrets.isEmpty {
                ErrorRow(error: error) { Task { await model.load(api: api) } }
            } else if model.secrets.isEmpty {
                EmptyState(title: "No secrets", systemImage: "key",
                           message: "Add API keys for Claude Code, Codex, or GitHub to get started.")
            } else {
                ScopedSections(groups: groups, id: \.listId, what: "secrets", footer: footer) { s, scope in
                    row(s, scope)
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
            SecretFormSheet(repos: model.repos, canOrg: context.isAdmin) { result in
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
                        // Someone else's private secret (an admin, offboarding) names its owner.
                        let other = context.scope(ofOwner: s.owner) == .others
                        try await api.deleteSecret(name: s.name, scope: s.scope, userId: other ? s.owner : nil)
                        await model.load(api: api)
                    } catch { errorMessage = error.moreDescription }
                }
            }
        } message: {
            if let s = pendingDelete, context.scope(ofOwner: s.owner) == .others {
                Text("\(s.ownerName ?? "Its owner")'s private secret. Only their work could use it.")
            }
        }
        .toast(notice, tone: .success) { notice = nil }
        .moreErrorAlert($errorMessage)
    }

    private func row(_ s: SecretRow, _ scope: OwnerScope) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(.body.monospaced())
                if let u = s.updatedAt ?? s.createdAt {
                    Text("Updated \(u.relativeDescription)").font(.caption2).foregroundStyle(.tertiary)
                }
            }
            Spacer()
            switch scope {
            case .organization:
                Label(model.repoLabel(s.scope), systemImage: s.scope == nil || s.scope == "global" ? "globe" : "folder")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            case .private:
                EmptyView()
            case .others:
                Label(s.ownerName ?? "Someone", systemImage: "person")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .swipeActions(edge: .trailing) {
            // The organization's: admins. Yours: you. Someone else's: an admin, for offboarding.
            if ScopeRules.canDelete(scope, orgRule: context.isAdmin, isAdmin: context.isAdmin) {
                Button(role: .destructive) { pendingDelete = s } label: { Label("Delete", systemImage: "trash") }
            }
        }
    }

    private func footer(_ scope: OwnerScope) -> String? {
        switch scope {
        case .organization:
            return "Values are encrypted at rest and never returned by the API."
        case .private:
            return groups.private.isEmpty ? nil
                : "Private secrets are yours alone: only your work gets them, so the organization's background runs (ticket sync, schedules, webhooks) don't see them. Store a credential as Organization to make it available everywhere."
        case .others:
            return "Other people's private secrets: only their work can use them. You can delete one when they leave."
        }
    }
}

/// Create or update a secret by name. The value field is a secure entry and is
/// discarded as soon as the request completes.
struct SecretFormSheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let repos: [RepoRow]
    /// Whether the viewer may make the organization's (an admin).
    let canOrg: Bool
    var onSaved: (SecretCreateResult) async -> Void

    @State private var name = ""
    @State private var value = ""
    /// Organization (`global`, or one repo's) or Private (`scope: "user"`).
    @State private var owner: ResourceOwner = .me
    /// For the organization's: every repo (`global`) or one repo's URL.
    @State private var repoScope = "global"
    @State private var saving = false
    @State private var errorMessage: String?

    private var scope: String { owner == .me ? "user" : repoScope }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("ANTHROPIC_API_KEY", text: $name)
                        .font(.body.monospaced())
                        .autocorrectionDisabled().textInputAutocapitalization(.characters)
                    SecureField("Value", text: $value)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                } footer: {
                    Text("Saving an existing name replaces its value. Auth tokens (CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY, GITHUB_TOKEN) are validated after saving.")
                }
                Section {
                    OwnerPicker(owner: $owner, what: "secret", canOrg: canOrg)
                    if owner == .workspace {
                        Picker("Repos", selection: $repoScope) {
                            Text("All repos").tag("global")
                            ForEach(repos) { repo in
                                if let url = repo.repoUrl { Text(repo.displayName).tag(url) }
                            }
                        }
                    }
                } footer: {
                    Text(OwnerPicker.hint(
                        owner: owner, what: "secret", canOrg: canOrg,
                        orgHint: "Every run in the workspace can use it.",
                        privateHint: "Only your own work gets it. Background runs of the organization's work (schedules, webhooks, ticket sync) don't."
                    ))
                }
            }
            .navigationTitle("Add Secret")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear { owner = canOrg ? .workspace : .me }
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
