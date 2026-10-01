import Foundation

// Port of the web's `agent-choice-model.ts` plus the repo-default precedence
// in `work-form/model.ts`: how a repo row's agent columns map to and from the
// picker's values (the picker's keys — `ProviderCatalog.modelField` and the
// option keys — are the repo column names), and where a New work draft's
// agent parameters start when a repo is picked.

extension WorkForm {
    /// The repo columns each runtime's picker reads and writes in a pod (model
    /// first) — `optionKeysFor(runtime, podOnly: true)`. Machine-only fields
    /// (the permission modes) have no repo column.
    static let repoOptionKeys: [String: [String]] = [
        "claude-code": ["claudeModel", "claudeContextWindow", "claudeEffort"],
        "codex": ["copilotModel", "copilotEffort"],
        "copilot": ["copilotModel", "copilotEffort"],
        "gemini": ["geminiModel", "geminiApprovalMode"],
        "cursor": ["cursorModel"],
        "opencode": ["opencodeModel", "opencodeAgent", "opencodeBaseUrl"],
        "openclaw": ["openclawModel", "openclawAgent"],
    ]

    /// Runtimes a repo keeps no settings for. Codex shares Copilot's
    /// copilotModel / copilotEffort columns, so those values are Copilot's.
    static let noRepoSettings: Set<String> = ["codex"]

    /// What a repo row holds when nobody has set its agent (the DB column defaults).
    static let repoFactoryAgent = "claude-code"
    static let repoFactoryOptions: AgentOptions = [
        "claudeModel": .string("opus"),
        "claudeContextWindow": .string("1m"),
        "claudeEffort": .string("high"),
        "geminiModel": .string("gemini-2.5-pro"),
        "geminiApprovalMode": .string("yolo"),
    ]

    /// The repo's configured values for this runtime's options, to seed the picker.
    static func optionsFromRepo(runtime: String, repo: [String: AnyCodable]?) -> AgentOptions {
        guard let repo, runtime != terminal, !noRepoSettings.contains(runtime) else { return [:] }
        var out: AgentOptions = [:]
        for k in repoOptionKeys[runtime] ?? [] {
            if let s = repo[k]?.stringValue { out[k] = .string(s) }
            else if let b = repo[k]?.boolValue { out[k] = .bool(b) }
        }
        return out
    }

    /// The repo has settings of its own for `runtime` — a value that isn't the column default.
    static func repoHasOwnOptions(_ runtime: String, repo: [String: AnyCodable]?) -> Bool {
        optionsFromRepo(runtime: runtime, repo: repo).contains { k, v in !v.isBlank && repoFactoryOptions[k] != v }
    }

    /// The repo's default agent, when someone picked one (or set its options).
    static func repoOwnRuntime(_ repo: [String: AnyCodable]?) -> String? {
        guard let repo, let agent = repo["defaultAgentType"]?.stringValue,
              runtimes.contains(where: { $0.value == agent }) else { return nil }
        return agent != repoFactoryAgent || repoHasOwnOptions(agent, repo: repo) ? agent : nil
    }

    /// The repo's default agent as the form names it ("claude-code" when unset).
    static func repoRuntime(_ repo: [String: AnyCodable]) -> String {
        if let agent = repo["defaultAgentType"]?.stringValue, runtimes.contains(where: { $0.value == agent }) { return agent }
        return repoFactoryAgent
    }

    /// Every agent column on a repo row, as one picker-values map; columns the
    /// DB leaves null read as the column default.
    static func repoAgentValues(_ repo: [String: AnyCodable]) -> AgentOptions {
        var out: AgentOptions = [:]
        for r in runtimes { out.merge(optionsFromRepo(runtime: r.value, repo: repo)) { a, _ in a } }
        for (k, v) in repoFactoryOptions where out[k] == nil || out[k]?.isBlank == true { out[k] = v }
        return out
    }

    /// Claude Code's strings go as they are (blank effort = the model's own).
    private static let sentAsIs: Set<String> = ["claudeModel", "claudeContextWindow", "claudeEffort"]

    /// The agent part of `PATCH /api/repos/:id`: the default agent and every
    /// agent column. The OpenCode base URL blank clears it (null); any other
    /// blank is left out (left alone). Never `claudeThinking`.
    static func repoAgentPatch(runtime: String, values: AgentOptions) -> [String: AnyCodable] {
        var patch: [String: AnyCodable] = ["defaultAgentType": .string(runtime)]
        let keys = Set(repoOptionKeys.values.flatMap { $0 })
        for k in keys {
            let v = values[k]
            if let b = v?.boolValue { patch[k] = .bool(b); continue }
            let s = v?.stringValue
            if k == "opencodeBaseUrl" { patch[k] = (s ?? "").isEmpty ? .null : .string(s!) }
            else if sentAsIs.contains(k) { if let s { patch[k] = .string(s) } }
            else if let s, !s.isEmpty { patch[k] = .string(s) }
        }
        return patch
    }

    /// "Claude Code · opus · high" — a repo's agent at a glance.
    static func agentSummary(runtime: String, values: AgentOptions) -> String {
        guard runtime != terminal else { return "" }
        let keys = noRepoSettings.contains(runtime) ? [] : (repoOptionKeys[runtime] ?? [])
        let model = keys.first.flatMap { values[$0]?.stringValue }
        let effort = keys.first { $0.hasSuffix("Effort") }.flatMap { values[$0]?.stringValue }
        return ([runtimeLabel(runtime), model, effort].compactMap { $0 }.filter { !$0.isEmpty }).joined(separator: " · ")
    }

    // MARK: - Repo defaults in the New work form

    /// The repo's saved agent defaults apply: pod work, with a repo, driven by an agent.
    static func repoDefaultsApply(_ d: Draft) -> Bool { fullOptionsApply(d) && d.withRepo }

    enum OptionsSource: Equatable { case repo, saved, none }

    /// Where a runtime's parameters start. For pod work with a repo, a repo with
    /// settings of its own wins; otherwise the settings you used last; otherwise
    /// the repo's (its column defaults), or nothing.
    static func startingOptions(_ d: Draft, runtime: String, repo: [String: AnyCodable]?, saved: AgentOptions?) -> (options: AgentOptions, from: OptionsSource) {
        var probe = d
        probe.runtime = runtime
        let repoApplies = repo != nil && repoDefaultsApply(probe)
        if repoApplies, repoHasOwnOptions(runtime, repo: repo) { return (optionsFromRepo(runtime: runtime, repo: repo), .repo) }
        if let saved { return (saved, .saved) }
        if repoApplies { return (optionsFromRepo(runtime: runtime, repo: repo), .repo) }
        return ([:], .none)
    }

    /// The draft on `runtime`, its parameters started by `startingOptions`.
    static func startWith(_ d: Draft, runtime: String, repo: [String: AnyCodable]?, saved: AgentOptions?, providers: [ModelProvider]) -> Draft {
        var fresh = d
        fresh.runtime = runtime
        fresh.agentOptions = [:]
        let (options, from) = startingOptions(fresh, runtime: runtime, repo: repo, saved: saved)
        if from == .saved { return normalize(withSavedOptions(fresh, options, providers: providers)) }
        fresh.agentOptions = options
        return normalize(fresh)
    }

    /// A repo with saved defaults of its own takes over the agent: its default
    /// agent (when that can run here) and that agent's parameters. A repo nobody
    /// configured leaves the draft alone, so your last settings stand.
    static func withRepoDefaults(_ d: Draft, repo: [String: AnyCodable]?) -> Draft {
        guard let repo, repoDefaultsApply(d) else { return d }
        let own = repoOwnRuntime(repo)
        let runtime = own.flatMap { o in runtimeOptions(d).contains { $0.value == o && $0.isEnabled } ? o : nil } ?? d.runtime
        if runtime == d.runtime, !repoHasOwnOptions(runtime, repo: repo) { return d }
        var next = d
        next.runtime = runtime
        next.agentOptions = optionsFromRepo(runtime: runtime, repo: repo)
        return normalize(next)
    }

    /// The draft's agent and its parameters are still the repo's defaults.
    static func matchesRepoDefaults(_ d: Draft, repo: [String: AnyCodable]?) -> Bool {
        guard let repo else { return false }
        return d.runtime == repoRuntime(repo) && sameOptions(d.agentOptions, optionsFromRepo(runtime: d.runtime, repo: repo))
    }

    /// Back to the repo's defaults: its agent (when it can run here) and that agent's parameters.
    static func resetToRepoDefaults(_ d: Draft, repo: [String: AnyCodable]?) -> Draft {
        guard let repo else { return d }
        let wanted = repoRuntime(repo)
        var next = d
        if runtimeOptions(d).contains(where: { $0.value == wanted && $0.isEnabled }) { next.runtime = wanted }
        next.agentOptions = optionsFromRepo(runtime: next.runtime, repo: repo)
        return normalize(next)
    }
}

// MARK: - Per-model effort

extension ProviderCatalog {
    /// The catalog model a stored value names ("opus" resolves through the aliases).
    func model(named raw: String) -> Model? {
        let id = WorkForm.resolveModel(raw, aliases: aliases)
        return id.isEmpty ? nil : models.first { $0.id == id }
    }

    /// `optionChoicesFor`: a `modelEfforts` field narrows to the selected model's
    /// own efforts, in its order (an unknown one labelled by its value); an empty
    /// list means the model takes no effort (no choices — hide the field). Any
    /// other field, or a model that lists no efforts, gets the static choices.
    static func choices(for field: Option, model: Model?) -> [Choice] {
        let choices = field.choices ?? []
        guard field.modelEfforts == true, let efforts = model?.efforts else { return choices }
        return efforts.map { e in
            choices.first { $0.value == e } ?? Choice(value: e, label: e.prefix(1).uppercased() + e.dropFirst(), description: nil)
        }
    }

    /// Option keys whose value the newly picked model doesn't take — a reasoning
    /// effort that goes back to its default rather than riding into a run it would fail.
    func keysToReset(_ values: WorkForm.AgentOptions, newModel raw: String) -> [String] {
        guard let efforts = model(named: raw)?.efforts else { return [] }
        return options.compactMap { f in
            guard f.modelEfforts == true, let v = values[f.key]?.stringValue, !v.isEmpty, !efforts.contains(v) else { return nil }
            return f.key
        }
    }
}
