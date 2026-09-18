import SwiftUI

/// Personal access tokens (`/api/auth/api-keys`). A new token is shown exactly
/// once, in the creation sheet, with a copy button; only its prefix is listed after.
struct ApiKeysView: View {
    @Environment(APIClient.self) private var api
    @State private var keys: [ApiKeyRow] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var showCreate = false
    @State private var pendingRevoke: ApiKeyRow?
    @State private var errorMessage: String?

    var body: some View {
        List {
            if loading {
                ProgressView().frame(maxWidth: .infinity)
            } else if let loadError, keys.isEmpty {
                ErrorRow(error: loadError) { Task { await load() } }
            } else if keys.isEmpty {
                EmptyState(title: "No tokens", systemImage: "key.horizontal",
                           message: "Create a token to sign in from the CLI or another device.")
            } else {
                Section {
                    ForEach(keys) { k in
                        VStack(alignment: .leading, spacing: 3) {
                            Text(k.name ?? "API key").font(.subheadline)
                            if let p = k.prefix { Text("\(p)…").font(.caption.monospaced()).foregroundStyle(.secondary) }
                            HStack(spacing: 8) {
                                if let c = k.createdAt { Text("created \(c.relativeDescription)") }
                                if let u = k.lastUsedAt { Text("used \(u.relativeDescription)") } else { Text("never used") }
                                if let e = k.expiresAt { Text("expires \(e.relativeDescription)") }
                            }
                            .font(.caption2).foregroundStyle(.tertiary)
                        }
                        .swipeActions(edge: .trailing) {
                            Button(role: .destructive) { pendingRevoke = k } label: { Label("Revoke", systemImage: "trash") }
                        }
                    }
                } footer: {
                    Text("Revoking the token this app signed in with will sign you out.")
                }
            }
        }
        .navigationTitle("Access Tokens")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showCreate = true } label: { Image(systemName: "plus") }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(isPresented: $showCreate) {
            CreateApiKeySheet { await load() }
        }
        .confirmationDialog("Revoke \"\(pendingRevoke?.name ?? "token")\"?", isPresented: Binding(
            get: { pendingRevoke != nil }, set: { if !$0 { pendingRevoke = nil } }
        ), titleVisibility: .visible) {
            Button("Revoke", role: .destructive) {
                guard let k = pendingRevoke else { return }
                Task {
                    do { try await api.revokeApiKey(k.id); await load() }
                    catch { errorMessage = error.moreDescription }
                }
            }
        } message: { Text("Anything using this token will stop working immediately.") }
        .moreErrorAlert($errorMessage)
    }

    private func load() async {
        do {
            keys = try await api.listApiKeys()
            loadError = nil
        } catch {
            loadError = error
        }
        loading = false
    }
}

struct CreateApiKeySheet: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    var onCreated: () async -> Void

    @State private var name = ""
    @State private var expires = false
    @State private var expiresAt = Calendar.current.date(byAdding: .day, value: 90, to: .now) ?? .now
    @State private var creating = false
    @State private var created: CreatedApiKey?
    @State private var errorMessage: String?

    var body: some View {
        NavigationStack {
            Form {
                if let created {
                    Section {
                        Text(created.token)
                            .font(.footnote.monospaced())
                            .textSelection(.enabled)
                        MoreCopyButton(text: created.token, label: "Copy token")
                    } header: {
                        Text("Your new token")
                    } footer: {
                        Text("This is the only time the full token is shown. Store it somewhere safe.")
                    }
                } else {
                    Section {
                        TextField("Name (e.g. iPad)", text: $name)
                        Toggle("Expires", isOn: $expires.animation())
                        if expires {
                            DatePicker("Expires on", selection: $expiresAt, in: Date.now..., displayedComponents: .date)
                        }
                    } footer: {
                        Text("Tokens start with optio_pat_ and are sent as a bearer header, like the CLI.")
                    }
                }
            }
            .navigationTitle(created == nil ? "New Token" : "Token Created")
            .navigationBarTitleDisplayMode(.inline)
            .interactiveDismissDisabled(created != nil)
            .toolbar {
                if created == nil {
                    ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                    ToolbarItem(placement: .confirmationAction) {
                        Button { Task { await create() } } label: {
                            if creating { ProgressView() } else { Text("Create") }
                        }
                        .disabled(creating)
                    }
                } else {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done") { Task { await onCreated(); dismiss() } }
                    }
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private func create() async {
        creating = true
        defer { creating = false }
        do {
            created = try await api.createApiKey(name: name.isEmpty ? "iOS (\(UIDevice.current.name))" : name,
                                                 expiresAt: expires ? expiresAt : nil)
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
