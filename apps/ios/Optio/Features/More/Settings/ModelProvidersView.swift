import SwiftUI

private typealias F = WorkForm

/// Settings → Model providers: saved ways for an agent to reach its models
/// (Amazon Bedrock for Claude Code and Codex). Credentials are write-only.
struct ModelProvidersView: View {
    @Environment(APIClient.self) private var api
    @Environment(MoreContext.self) private var context
    @State private var providers: [ModelProvider] = []
    @State private var loading = true
    @State private var loadError: Error?
    @State private var editing: EditTarget?
    @State private var pendingDelete: ModelProvider?
    @State private var errorMessage: String?

    private enum EditTarget: Identifiable {
        case new
        case existing(ModelProvider)
        var id: String { if case .existing(let p) = self { return p.id } else { return "new" } }
        var provider: ModelProvider? { if case .existing(let p) = self { return p } else { return nil } }
    }

    var body: some View {
        List {
            if loading, providers.isEmpty {
                ProgressView().frame(maxWidth: .infinity)
            } else if let loadError, providers.isEmpty {
                ErrorRow(error: loadError) { Task { await load() } }
            } else if providers.isEmpty {
                EmptyState(title: "No model providers", systemImage: "cloud",
                           message: "Add Amazon Bedrock to run Claude Code or Codex through your AWS account.")
            } else {
                Section {
                    ForEach(providers, id: \.id) { p in
                        Button { if p.canEdit { editing = .existing(p) } } label: { row(p) }
                            .buttonStyle(.plain)
                            .swipeActions(edge: .trailing) {
                                if p.canEdit {
                                    Button(role: .destructive) { pendingDelete = p } label: { Label("Delete", systemImage: "trash") }
                                }
                            }
                    }
                } footer: {
                    Text("Pick a provider per piece of work under Who. Organization providers can be used by everyone; yours only by work that runs as you.")
                }
            }
        }
        .navigationTitle("Model providers")
        .toolbar {
            if context.isMember {
                ToolbarItem(placement: .primaryAction) {
                    Button { editing = .new } label: { Image(systemName: "plus") }
                        .accessibilityLabel("Add model provider")
                }
            }
        }
        .task { await load() }
        .refreshable { await load() }
        .sheet(item: $editing) { target in
            ModelProviderEditor(existing: target.provider, isAdmin: context.isAdmin) { await load() }
        }
        .confirmationDialog("Delete \(pendingDelete?.name ?? "")?", isPresented: Binding(
            get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }
        ), titleVisibility: .visible) {
            Button("Delete", role: .destructive) {
                guard let p = pendingDelete else { return }
                Task {
                    do { try await api.deleteModelProvider(p.id); await load() }
                    catch { errorMessage = error.moreDescription }
                }
            }
        } message: {
            Text("Work that picks it can't run until it picks another provider.")
        }
        .moreErrorAlert($errorMessage)
    }

    private func row(_ p: ModelProvider) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: Spacing.s) {
                Text(p.name).font(.body.weight(.medium))
                Text("Bedrock").font(.caption2.weight(.semibold))
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(.fill.tertiary, in: Capsule())
                Spacer()
                Label(p.ownerUserId == nil ? "Organization" : (p.mine ? "Just me" : (p.ownerName ?? "Someone")),
                      systemImage: p.ownerUserId == nil ? "building.2" : "person")
                    .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
            Text("\(p.agents.filter { $0 != .unknown }.map(F.agentLabel).joined(separator: ", ")) · \(p.region) · Pods: \(F.podCredentialLabel(p.podCredential))")
                .font(.footnote).foregroundStyle(.secondary)
        }
        .contentShape(Rectangle())
    }

    private func load() async {
        loading = providers.isEmpty
        defer { loading = false }
        do { providers = try await api.listModelProviders(); loadError = nil }
        catch { loadError = error }
    }
}

/// Create or edit a provider. Credentials are write-only: "Stored" with
/// Replace / Clear when the provider has them.
private struct ModelProviderEditor: View {
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    let existing: ModelProvider?
    let isAdmin: Bool
    let onSaved: () async -> Void

    private struct ModelDraft: Identifiable, Hashable { let id = UUID(); var modelId: String; var label: String }
    private enum CredAction: Hashable { case keep, replace, clear }

    @State private var name = ""
    @State private var owner: ResourceOwner = .me
    @State private var agents: Set<ModelProviderAgent> = [.claudeCode]
    @State private var region = "us-west-2"
    @State private var models: [ModelProviderAgent: [ModelDraft]] = [:]
    @State private var awsProfile = ""
    @State private var podCredential: ModelProviderPodCredential = .accessKey
    @State private var credAction: CredAction = .replace
    @State private var accessKeyId = ""
    @State private var secretAccessKey = ""
    @State private var sessionToken = ""
    @State private var bearerToken = ""
    @State private var saving = false
    @State private var errorMessage: String?
    @State private var loaded = false

    private let allAgents: [ModelProviderAgent] = [.claudeCode, .codex]
    private var storesCredentials: Bool { podCredential == .accessKey || podCredential == .bearerToken }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name, prompt: Text("Bedrock (us-west-2)"))
                    Picker("Owner", selection: $owner) {
                        if isAdmin || existing?.ownerUserId == nil { Text("Organization").tag(ResourceOwner.workspace) }
                        Text("Just me").tag(ResourceOwner.me)
                    }
                    .disabled(!isAdmin)
                    ForEach(allAgents, id: \.self) { a in
                        Toggle(F.agentLabel(a), isOn: Binding(
                            get: { agents.contains(a) },
                            set: { on in
                                if on { agents.insert(a); if (models[a] ?? []).isEmpty { models[a] = defaults(a) } }
                                else { agents.remove(a) }
                            }
                        ))
                    }
                    ValueField(label: "Region", placeholder: "us-west-2", text: $region)
                } header: {
                    Text("Amazon Bedrock")
                } footer: {
                    if !isAdmin { Text("Only admins add providers for the whole organization.") }
                    else if !F.isValidAwsRegion(region) { Text("Expected an AWS region like us-west-2.") }
                }

                ForEach(allAgents.filter { agents.contains($0) }, id: \.self) { a in
                    Section {
                        ForEach(Binding(get: { models[a] ?? [] }, set: { models[a] = $0 })) { $m in
                            VStack(alignment: .leading, spacing: 2) {
                                TextField("Model id", text: $m.modelId)
                                    .font(.body.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                                TextField("Label (optional)", text: $m.label).font(.footnote)
                            }
                        }
                        .onDelete { models[a]?.remove(atOffsets: $0) }
                        .onMove { models[a]?.move(fromOffsets: $0, toOffset: $1) }
                        Button { models[a, default: []].append(ModelDraft(modelId: "", label: "")) } label: {
                            Label("Add model", systemImage: "plus")
                        }
                        Button("Reset to suggested") { models[a] = defaults(a) }
                    } header: {
                        Text("\(F.agentLabel(a)) models")
                    } footer: {
                        Text("The first is the default.")
                    }
                }

                Section {
                    ValueField(label: "AWS profile", placeholder: "default", text: $awsProfile)
                } header: {
                    Text("On your machines")
                } footer: {
                    Text("Blank uses the machine's default AWS credentials. Nothing is sent to your machines.")
                }

                Section {
                    Picker("Pods sign in with", selection: $podCredential) {
                        Text("Access key").tag(ModelProviderPodCredential.accessKey)
                        Text("Bedrock API key").tag(ModelProviderPodCredential.bearerToken)
                        Text("Pod IAM role").tag(ModelProviderPodCredential.ambient)
                        Text("Machines only").tag(ModelProviderPodCredential.none)
                    }
                    if storesCredentials {
                        if existing?.hasPodCredentials == true {
                            Picker("Stored credentials", selection: $credAction) {
                                Text("Keep").tag(CredAction.keep)
                                Text("Replace").tag(CredAction.replace)
                                Text("Clear").tag(CredAction.clear)
                            }
                            .pickerStyle(.segmented)
                        }
                        if credAction == .replace {
                            if podCredential == .accessKey {
                                TextField("Access key id", text: $accessKeyId)
                                    .font(.body.monospaced()).autocorrectionDisabled().textInputAutocapitalization(.never)
                                SecureField("Secret access key", text: $secretAccessKey)
                                SecureField("Session token (optional)", text: $sessionToken)
                            } else {
                                SecureField("Bedrock API key", text: $bearerToken)
                            }
                        }
                    }
                } header: {
                    Text("In pods")
                } footer: {
                    Text(podFooter)
                }
            }
            .navigationTitle(existing == nil ? "New provider" : "Edit provider")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear(perform: seed)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await save() } } label: { if saving { ProgressView() } else { Text("Save") } }
                        .disabled(!canSave)
                }
            }
            .moreErrorAlert($errorMessage)
        }
    }

    private var podFooter: String {
        if existing?.hasPodCredentials == true, storesCredentials, credAction == .keep { return "Stored — values are write-only and never shown." }
        switch podCredential {
        case .ambient: return "Pods use their own AWS identity (IRSA / instance profile)."
        case .none, .unknown: return "Work in a pod can't use this provider; machines only."
        default: return "Encrypted at rest; never returned by the API."
        }
    }

    private var credentialsFilled: Bool {
        podCredential == .accessKey ? (!accessKeyId.isEmpty && !secretAccessKey.isEmpty) : !bearerToken.isEmpty
    }

    private var canSave: Bool {
        guard !saving, !name.trimmingCharacters(in: .whitespaces).isEmpty, !agents.isEmpty, F.isValidAwsRegion(region) else { return false }
        if storesCredentials, credAction == .replace, !credentialsFilled {
            // New providers may be saved without credentials only if the user clears them deliberately.
            return false
        }
        return true
    }

    private func defaults(_ a: ModelProviderAgent) -> [ModelDraft] {
        F.bedrockDefaultModels(a, region: region).map { ModelDraft(modelId: $0.id, label: $0.label ?? "") }
    }

    private func seed() {
        guard !loaded else { return }
        loaded = true
        guard let p = existing else {
            owner = isAdmin ? .workspace : .me
            models[.claudeCode] = defaults(.claudeCode)
            return
        }
        name = p.name
        owner = p.ownerUserId == nil ? .workspace : .me
        agents = Set(p.agents.filter { $0 != .unknown })
        region = p.region
        for a in allAgents { models[a] = F.providerModels(p, agent: a).map { ModelDraft(modelId: $0.id, label: $0.label ?? "") } }
        awsProfile = p.localAwsProfile ?? ""
        podCredential = p.podCredential == .unknown ? .none : p.podCredential
        credAction = p.hasPodCredentials ? .keep : .replace
    }

    private func requestBody() -> [String: AnyCodable] {
        var out: [String: AnyCodable] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "agents": .array(allAgents.filter { agents.contains($0) }.map { .string($0.rawValue) }),
            "region": .string(region.trimmingCharacters(in: .whitespaces)),
            "localAwsProfile": awsProfile.trimmingCharacters(in: .whitespaces).isEmpty ? .null : .string(awsProfile.trimmingCharacters(in: .whitespaces)),
            "podCredential": .string(podCredential.rawValue),
        ]
        if existing == nil || isAdmin { out["owner"] = .string(owner.rawValue) }
        if existing == nil { out["kind"] = .string("bedrock") }
        var byAgent: [String: AnyCodable] = [:]
        for a in allAgents where agents.contains(a) {
            byAgent[a.rawValue] = .array((models[a] ?? []).compactMap { m in
                let id = m.modelId.trimmingCharacters(in: .whitespaces)
                guard !id.isEmpty else { return nil }
                var o: [String: AnyCodable] = ["id": .string(id)]
                let label = m.label.trimmingCharacters(in: .whitespaces)
                if !label.isEmpty { o["label"] = .string(label) }
                return .object(o)
            })
        }
        out["models"] = .object(byAgent)
        if storesCredentials {
            switch credAction {
            case .keep: break
            case .clear: out["credentials"] = .null
            case .replace:
                if podCredential == .accessKey {
                    var c: [String: AnyCodable] = ["type": .string("access-key"), "accessKeyId": .string(accessKeyId.trimmingCharacters(in: .whitespaces)), "secretAccessKey": .string(secretAccessKey)]
                    if !sessionToken.isEmpty { c["sessionToken"] = .string(sessionToken) }
                    out["credentials"] = .object(c)
                } else {
                    out["credentials"] = .object(["type": .string("bearer-token"), "bearerToken": .string(bearerToken)])
                }
            }
        } else if existing?.hasPodCredentials == true {
            // Ambient / machines only: nothing stored is needed any more.
            out["credentials"] = .null
        }
        return out
    }

    private func save() async {
        saving = true
        defer { saving = false }
        do {
            if let existing { _ = try await api.updateModelProvider(existing.id, requestBody()) }
            else { _ = try await api.createModelProvider(requestBody()) }
            accessKeyId = ""; secretAccessKey = ""; sessionToken = ""; bearerToken = ""
            await onSaved()
            dismiss()
        } catch {
            errorMessage = error.moreDescription
        }
    }
}
