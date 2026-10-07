import Foundation

// Model providers, owners, and pod secrets in the work form — the pure half
// (the web's `work-form/model.ts` provider helpers). See the Settings screen
// (`ModelProvidersView`) for where providers are made.
//
//   Provider  `agentOptions.modelProvider = <id>`; the model field then holds
//             one of the provider's own model ids.
//   Owner     Organization (`workspace`) or Private (`me`). Work on a machine
//             always belongs to you.
//   Secrets   the names a pod gets (`podSecrets`); only what you pick.

extension WorkForm {
    /// `MODEL_PROVIDER_OPTION_KEY` in @optio/shared.
    static let modelProviderKey = "modelProvider"

    /// The provider agent a runtime is, when providers can serve it.
    static func providerAgent(_ runtime: String) -> ModelProviderAgent? {
        switch runtime {
        case "claude-code": return .claudeCode
        case "codex": return .codex
        default: return nil
        }
    }

    /// `modelProviderIdFrom`: the provider the draft's options pick.
    static func modelProviderId(_ d: Draft) -> String? {
        let v = d.agentOptions[modelProviderKey]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
        return v.isEmpty ? nil : v
    }

    /// Work on a machine is always yours; pod work is what the Owner row says.
    static func effectiveOwner(_ d: Draft) -> ResourceOwner { isLocal(d) ? .me : d.owner }

    /// Owner / secrets apply to rows that run in a pod — an agent, or a command
    /// (a terminal that exits) — not a pod session (web `isPodWork`).
    static func takesPodAccess(_ d: Draft) -> Bool {
        guard !isLocal(d), !(d.runtime == terminal && d.then != .exits) else { return false }
        return [.repoTask, .repoBlueprint, .standalone, .persistentAgent].contains(deriveKind(d))
    }

    /// Providers the work may pick for its runtime: the organization's, plus
    /// your own (picking one makes the work yours). Others' personal providers
    /// (visible to admins by name) never are.
    static func usableProviders(_ providers: [ModelProvider], runtime: String) -> [ModelProvider] {
        guard let agent = providerAgent(runtime) else { return [] }
        return providers.filter { p in
            p.kind == .bedrock && p.agents.contains(agent) && (p.ownerUserId == nil || p.mine)
        }
    }

    static func isPersonal(_ p: ModelProvider) -> Bool { p.ownerUserId != nil }

    /// Why a provider can't be picked here, if it can't.
    static func providerDisabled(_ p: ModelProvider, _ d: Draft, host: LocalHost?) -> String? {
        if isLocal(d) {
            guard let host else { return nil }
            if host.modelProviders != true { return "Update Optio Local on \(host.name) to use model providers" }
            if let profile = p.localAwsProfile, !profile.isEmpty, !(host.awsProfiles ?? []).contains(profile) {
                return "AWS profile \(profile) isn't on \(host.name)"
            }
            return nil
        }
        return p.podCredential == .none ? "Machines only" : nil
    }

    /// The provider's models for an agent, in picker order (first = default).
    static func providerModels(_ p: ModelProvider, agent: ModelProviderAgent) -> [ModelProviderModel] {
        let list: [ModelProviderModel]?
        switch agent {
        case .claudeCode: list = p.models.claudeCode
        case .codex: list = p.models.codex
        default: list = nil
        }
        return (list ?? []).filter { !$0.id.isEmpty }
    }

    /// Pick a provider (nil = Default): sets the option key, swaps the model to
    /// the provider's first (or clears it), and makes the work yours when the
    /// provider is.
    static func pickProvider(_ d: Draft, _ p: ModelProvider?) -> Draft {
        var next = d
        let field = modelField(forRuntime: d.runtime)
        if let p, let agent = providerAgent(d.runtime) {
            next.agentOptions[modelProviderKey] = .string(p.id)
            next.agentOptions[field] = .string(providerModels(p, agent: agent).first?.id ?? "")
            if isPersonal(p) { next.owner = .me }
        } else {
            let had = modelProviderId(d) != nil
            next.agentOptions.removeValue(forKey: modelProviderKey)
            if had { next.agentOptions[field] = .string("") }
        }
        return next
    }

    /// Change the owner. Organization work can only use the organization's
    /// providers and secrets, so personal picks fall away.
    static func setOwner(_ d: Draft, _ owner: ResourceOwner, providers: [ModelProvider], secrets: [PickableSecret]) -> Draft {
        var next = d
        next.owner = owner
        guard owner == .workspace else { return next }
        if let id = modelProviderId(d), let p = providers.first(where: { $0.id == id }), isPersonal(p) {
            next = pickProvider(next, nil)
        }
        let orgNames = Set(secrets.filter { $0.owner == .workspace }.map(\.name))
        next.podSecrets = d.podSecrets.filter { orgNames.contains($0) }
        return next
    }

    /// Secrets the Add menu offers: org work sees the org's; your work sees both.
    /// A name in both lists shows once, as yours (yours wins at run time).
    static func pickableSecrets(_ secrets: [PickableSecret], owner: ResourceOwner, picked: [String]) -> [PickableSecret] {
        var seen = Set(picked)
        var out: [PickableSecret] = []
        let ordered = secrets.filter { $0.owner == .me } + secrets.filter { $0.owner == .workspace }
        for s in ordered where owner == .me || s.owner == .workspace {
            if seen.insert(s.name).inserted { out.append(s) }
        }
        return out.sorted { $0.name < $1.name }
    }

    /// The owner tag a picked name shows ("private" when yours).
    static func secretOwner(_ name: String, _ secrets: [PickableSecret], owner: ResourceOwner) -> PickableSecret.Owner {
        if owner == .me, secrets.contains(where: { $0.name == name && $0.owner == .me }) { return .me }
        return secrets.contains { $0.name == name && $0.owner == .workspace } ? .workspace : .me
    }

    /// The `owner` / `podSecrets` body fields a create carries.
    static func accessPayload(_ d: Draft) -> [String: AnyCodable] {
        var out: [String: AnyCodable] = ["owner": .string(effectiveOwner(d).rawValue)]
        if takesPodAccess(d) { out["podSecrets"] = .array(d.podSecrets.map { .string($0) }) }
        return out
    }

    /// "Pods: access key" etc. for a provider row.
    static func podCredentialLabel(_ c: ModelProviderPodCredential) -> String {
        switch c {
        case .accessKey: return "access key"
        case .bearerToken: return "API key"
        case .ambient: return "IAM role"
        case .none, .unknown: return "machines only"
        }
    }

    static func agentLabel(_ a: ModelProviderAgent) -> String {
        switch a {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .unknown: return "Unknown"
        }
    }

    // MARK: - Settings editor helpers

    /// `isValidAwsRegion` in @optio/shared.
    static func isValidAwsRegion(_ region: String) -> Bool {
        region.wholeMatch(of: /[a-z]{2}(-[a-z]+)+-\d+/) != nil
    }

    /// `bedrockInferencePrefix`.
    static func bedrockInferencePrefix(_ region: String) -> String {
        if region.hasPrefix("us-gov-") { return "us-gov" }
        if region.hasPrefix("us-") || region.hasPrefix("ca-") { return "us" }
        if region.hasPrefix("eu-") { return "eu" }
        if region.hasPrefix("ap-") { return "apac" }
        return "global"
    }

    /// `bedrockDefaultModels`: suggested models for a new provider.
    static func bedrockDefaultModels(_ agent: ModelProviderAgent, region: String) -> [ModelProviderModel] {
        if agent == .codex {
            return [ModelProviderModel(id: "openai.gpt-5.5", label: "GPT-5.5"), ModelProviderModel(id: "openai.gpt-5.4", label: "GPT-5.4")]
        }
        let p = bedrockInferencePrefix(region)
        return [
            ModelProviderModel(id: "\(p).anthropic.claude-opus-5-5", label: "Opus 5.5"),
            ModelProviderModel(id: "\(p).anthropic.claude-sonnet-5", label: "Sonnet 5"),
            ModelProviderModel(id: "\(p).anthropic.claude-fable-5-1", label: "Fable 5.1"),
            ModelProviderModel(id: "\(p).anthropic.claude-haiku-4-5-20251001-v1:0", label: "Haiku 4.5"),
        ]
    }
}

// MARK: - API

extension APIClient {
    func listModelProviders() async throws -> [ModelProvider] {
        struct R: Decodable { var providers: [ModelProvider] }
        return try await get("/api/model-providers", as: R.self).providers
    }

    /// Body is `CreateModelProviderInput` (POST) or `UpdateModelProviderInput` (PATCH), as raw JSON.
    func createModelProvider(_ body: [String: AnyCodable]) async throws -> ModelProvider {
        struct R: Decodable { var provider: ModelProvider }
        return try await post("/api/model-providers", body: body, as: R.self).provider
    }

    func updateModelProvider(_ id: String, _ body: [String: AnyCodable]) async throws -> ModelProvider {
        struct R: Decodable { var provider: ModelProvider }
        return try await patch("/api/model-providers/\(id)", body: body, as: R.self).provider
    }

    func deleteModelProvider(_ id: String) async throws {
        try await delete("/api/model-providers/\(id)")
    }

    /// `GET /api/secrets/pickable`: names only (the org's and yours).
    func listPickableSecrets() async throws -> [PickableSecret] {
        struct R: Decodable { var secrets: [PickableSecret] }
        return try await get("/api/secrets/pickable", as: R.self).secrets
    }
}
