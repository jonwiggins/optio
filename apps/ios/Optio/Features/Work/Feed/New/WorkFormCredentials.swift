import Foundation

// Agent credentials in the work form — the pure half (the web's
// `work-form/model.ts` credential helpers). The Who section's "Signed in
// with" row lists how the agent may sign in: the agent's known secrets (an
// Anthropic API key, a Claude OAuth token, an OpenAI key, …) and the model
// providers (Amazon Bedrock) the work may use — the organization's and your
// own — with "Add credentials…" to store a new one.
//
//   Secret    `agentOptions.credential = "secret:<id>"`, and no provider.
//   Provider  today's pick: `agentOptions.modelProvider = <id>`, no credential.
//   Default   neither: the agent's usual sign-in on the server.
//
// Work on a machine takes none of it (the machine's own CLI login), so the
// row is for pod work that runs an agent.

extension WorkForm {
    /// `AGENT_CREDENTIAL_OPTION_KEY` in @optio/shared.
    static let credentialKey = "credential"

    /// The `credential` option, trimmed; nil when none is picked.
    static func credentialId(_ d: Draft) -> String? {
        let v = d.agentOptions[credentialKey]?.stringValue?.trimmingCharacters(in: .whitespaces) ?? ""
        return v.isEmpty ? nil : v
    }

    /// `secretIdFromCredential`: the secret row id a `credential` value names.
    static func secretIdFromCredential(_ value: String?) -> String? {
        guard let value else { return nil }
        let v = value.trimmingCharacters(in: .whitespaces)
        guard v.lowercased().hasPrefix("secret:") else { return nil }
        let id = String(v.dropFirst("secret:".count))
        return id.wholeMatch(of: /[0-9a-fA-F-]{36}/) != nil ? id : nil
    }

    /// The row shows for pod work that runs an agent: not a terminal, not a machine.
    static func showsCredentials(_ d: Draft) -> Bool { !isLocal(d) && d.runtime != terminal }

    /// What the picker lists: the server's list minus shapes this build doesn't know.
    static func usableCredentials(_ list: [AgentCredential]) -> [AgentCredential] {
        list.filter { $0.kind == .secret || $0.kind == .provider }
    }

    /// The credential the draft picks: a secret by its `credential` id, or the
    /// picked provider's entry.
    static func pickedCredential(_ d: Draft, _ list: [AgentCredential]) -> AgentCredential? {
        if let id = credentialId(d) { return list.first { $0.kind == .secret && $0.id == id } }
        if let pid = modelProviderId(d) { return list.first { $0.kind == .provider && $0.providerId == pid } }
        return nil
    }

    static func isPersonal(_ c: AgentCredential) -> Bool { c.owner == .me }

    /// Pick a credential (nil = Default). A provider entry is today's provider
    /// pick (`pickProvider`: model swap, owner); a secret sets `credential`,
    /// drops any provider, and makes the work yours when the secret is.
    static func pickCredential(_ d: Draft, _ c: AgentCredential?, providers: [ModelProvider]) -> Draft {
        guard let c else {
            var next = pickProvider(d, nil)
            next.agentOptions.removeValue(forKey: credentialKey)
            return next
        }
        if c.kind == .provider {
            guard let p = providers.first(where: { $0.id == c.providerId }) else { return d }
            var next = pickProvider(d, p)
            next.agentOptions.removeValue(forKey: credentialKey)
            return next
        }
        var next = modelProviderId(d) != nil ? pickProvider(d, nil) : d
        next.agentOptions[credentialKey] = .string(c.id)
        if isPersonal(c) { next.owner = .me }
        return next
    }

    /// Organization work can't use your own credential: the owner switch drops it.
    static func dropPersonalCredential(_ d: Draft, credentials: [AgentCredential]) -> Draft {
        guard d.owner == .workspace, let id = credentialId(d),
              let c = credentials.first(where: { $0.id == id }), isPersonal(c) else { return d }
        var next = d
        next.agentOptions.removeValue(forKey: credentialKey)
        return next
    }

    /// "Private" / "Organization", plus "default" for the one a run gets with no pick.
    static func credentialTag(_ c: AgentCredential) -> String {
        var parts = [c.owner == .me ? "Private" : "Organization"]
        if c.default { parts.append("default") }
        return parts.joined(separator: " · ")
    }

    /// The SF Symbol for a credential's method.
    static func credentialSymbol(_ c: AgentCredential) -> String {
        switch c.method {
        case .bedrock: return "cloud"
        case .oauthToken: return "person.badge.key"
        case .appServer: return "server.rack"
        case .githubToken: return "chevron.left.forwardslash.chevron.right"
        case .vertexAi: return "globe"
        case .apiKey, .unknown: return "key"
        }
    }
}

// MARK: - API

extension APIClient {
    /// `GET /api/agents/credentials`: how the agent may sign in, and what `+` can add.
    func listAgentCredentials(agentType: String, owner: ResourceOwner) async throws -> AgentCredentialOptions {
        try await get(
            "/api/agents/credentials",
            query: ["agentType": agentType, "owner": owner.rawValue],
            as: AgentCredentialOptions.self
        )
    }

    /// `POST /api/agents/credentials`: stores the secret (write-only) and returns the credential.
    func createAgentCredential(_ input: CreateAgentCredentialInput) async throws -> AgentCredential {
        struct R: Decodable { var credential: AgentCredential }
        return try await post("/api/agents/credentials", body: input, as: R.self).credential
    }

    /// `POST /api/agents/credentials/verify`: checks a value without storing it.
    func verifyAgentCredential(_ input: VerifyAgentCredentialInput) async throws -> VerifyAgentCredentialResult {
        try await post("/api/agents/credentials/verify", body: input, as: VerifyAgentCredentialResult.self)
    }
}
