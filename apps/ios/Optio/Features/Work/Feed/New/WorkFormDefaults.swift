import Foundation

// Remembered agent settings in the New work form (the web's `savedOptionsFor`
// / `applyWorkDefaults` / `workDefaultsFrom`). `GET /api/me/work-defaults`
// returns the runtime you last created work with and, per runtime, the
// options you submitted; a blank form starts from them, and a successful
// create saves them again (fire-and-forget).

extension WorkForm {
    /// The options you last used for `runtime`, minus what no longer applies: a
    /// model provider that's gone, someone else's, or doesn't serve the runtime
    /// is dropped along with its model (a provider's model id means nothing
    /// without it). Any other model is kept — free-text models exist. Nil when
    /// nothing is saved.
    static func savedOptions(_ defaults: WorkFormDefaults?, runtime: String, providers: [ModelProvider]) -> AgentOptions? {
        guard runtime != terminal, let saved = defaults?.agentOptions?[runtime] else { return nil }
        var out: AgentOptions = [:]
        for (k, v) in saved {
            switch v {
            case .string(let s): out[k] = .string(s)
            case .bool(let b): out[k] = .bool(b)
            case .int(let i): out[k] = .string(String(i))
            case .double(let x): out[k] = .string(String(x))
            default: break
            }
        }
        if let id = out[modelProviderKey]?.stringValue?.trimmingCharacters(in: .whitespaces), !id.isEmpty,
           !usableProviders(providers, runtime: runtime).contains(where: { $0.id == id }) {
            out.removeValue(forKey: modelProviderKey)
            out.removeValue(forKey: modelField(forRuntime: runtime))
        }
        return out.isEmpty ? nil : out
    }

    /// Start a runtime's parameters from saved options; a personal provider makes pod work yours.
    static func withSavedOptions(_ d: Draft, _ options: AgentOptions, providers: [ModelProvider]) -> Draft {
        var next = d
        next.agentOptions = options
        if let id = modelProviderId(next), let p = providers.first(where: { $0.id == id }), isPersonal(p), !isLocal(next) {
            next.owner = .me
        }
        return next
    }

    /// A blank form with your last settings: the saved runtime (when it can run
    /// here and isn't a terminal) and that runtime's saved options. Without
    /// saved options for the runtime it lands on, the draft's own stay.
    static func applyDefaults(_ d: Draft, _ defaults: WorkFormDefaults?, providers: [ModelProvider]) -> Draft {
        guard let defaults, d.runtime != terminal else { return d }
        var next = d
        if let wanted = defaults.runtime, wanted != terminal, wanted != d.runtime,
           runtimeOptions(d).contains(where: { $0.value == wanted && $0.isEnabled }) {
            next.runtime = wanted
            next.agentOptions = [:]
        }
        if let saved = savedOptions(defaults, runtime: next.runtime, providers: providers) {
            next = withSavedOptions(next, saved, providers: providers)
        }
        return normalize(next)
    }

    /// Same values, ignoring blank entries (a blank select means "default").
    static func sameOptions(_ a: AgentOptions, _ b: AgentOptions) -> Bool {
        a.filter { !$0.value.isBlank } == b.filter { !$0.value.isBlank }
    }

    /// What a successful create remembers: the runtime and the options actually
    /// submitted for it. Nil for a terminal.
    static func workDefaults(from d: Draft) -> WorkFormDefaults? {
        guard d.runtime != terminal else { return nil }
        return WorkFormDefaults(runtime: d.runtime, agentOptions: [d.runtime: setOptions(d) ?? [:]])
    }
}

extension APIClient {
    private struct WorkDefaultsEnvelope: Decodable { var defaults: WorkFormDefaults? }

    /// `GET /api/me/work-defaults` (`{}` when none are saved).
    func getWorkDefaults() async throws -> WorkFormDefaults {
        try await get("/api/me/work-defaults", as: WorkDefaultsEnvelope.self).defaults ?? WorkFormDefaults()
    }

    /// `PUT /api/me/work-defaults`: merges per runtime.
    func putWorkDefaults(_ body: WorkFormDefaults) async throws {
        _ = try await put("/api/me/work-defaults", body: body, as: WorkDefaultsEnvelope.self)
    }
}
