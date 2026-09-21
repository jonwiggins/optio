import Foundation
import Observation

// `GET /api/agents/:provider/options` — the provider catalog the web's
// `AgentOptionsPicker` renders. Fetched lazily per provider and cached for
// the life of the app; when the fetch fails the form falls back to a free-text
// model field keyed by `WorkForm.modelField(forProvider:)`.

struct ProviderCatalog: Decodable, Hashable, Sendable {
    struct Model: Decodable, Hashable, Sendable, Identifiable {
        let id: String
        let label: String
        let family: String?
        let latest: Bool?
        let preview: Bool?
        let source: String?

        var displayLabel: String {
            var s = label
            if latest == true { s += " (latest)" }
            if preview == true { s += " (Preview)" }
            return s
        }
    }

    struct Choice: Decodable, Hashable, Sendable, Identifiable {
        let value: String
        let label: String
        let description: String?
        var id: String { value }
    }

    struct Option: Decodable, Hashable, Sendable, Identifiable {
        let key: String
        let label: String
        let kind: String // "select" | "boolean" | "text"
        let choices: [Choice]?
        let `default`: AnyCodable?
        let placeholder: String?
        let helpText: String?
        var id: String { key }

        var defaultString: String { `default`?.stringValue ?? "" }
        var defaultBool: Bool { `default`?.boolValue ?? false }
    }

    let provider: String
    let label: String
    let modelField: String
    let modelIsFreeText: Bool?
    let modelPlaceholder: String?
    let modelHelpText: String?
    let models: [Model]
    let aliases: [String: String]?
    let options: [Option]
    let liveRefreshSupported: Bool?

    /// Keys `optionsFromRepo` reads off a repo row.
    var optionKeys: [String] { [modelField] + options.map(\.key) }

    /// Models grouped by family in first-seen order (`groupModelsByFamily`).
    var families: [(family: String, models: [Model])] {
        var order: [String] = []
        var byFamily: [String: [Model]] = [:]
        for m in models {
            let f = m.family ?? m.id
            if byFamily[f] == nil { order.append(f) }
            byFamily[f, default: []].append(m)
        }
        return order.map { ($0, byFamily[$0] ?? []) }
    }
}

struct ProviderOptionsResponse: Decodable {
    let provider: String
    let source: String?
    let cached: Bool?
    let refreshedAt: Double?
    let catalog: ProviderCatalog
    let error: String?
}

extension APIClient {
    func agentProviderOptions(_ provider: String, refresh: Bool = false) async throws -> ProviderOptionsResponse {
        try await get("/api/agents/\(provider)/options", query: ["refresh": refresh ? "true" : nil], as: ProviderOptionsResponse.self)
    }
}

/// Per-provider catalog cache shared by every form instance.
@MainActor
@Observable
final class AgentCatalogStore {
    static let shared = AgentCatalogStore()

    enum State: Sendable {
        case loading
        case loaded(ProviderCatalog)
        case failed(String)
    }

    private(set) var states: [String: State] = [:]

    func catalog(_ provider: String) -> ProviderCatalog? {
        if case .loaded(let c) = states[provider] { return c }
        return nil
    }

    func state(_ provider: String) -> State? { states[provider] }

    /// Fetch once per provider; callers observe `states`.
    func load(_ provider: String, api: APIClient) {
        if states[provider] != nil { return }
        states[provider] = .loading
        Task {
            do {
                let res = try await api.agentProviderOptions(provider)
                states[provider] = .loaded(res.catalog)
            } catch {
                states[provider] = .failed(ErrorText.humanize(error))
            }
        }
    }
}
