import Foundation
import Observation

// MARK: - Endpoints (the same six the web's `useSessionsFeed` fans out to)

extension APIClient {
    private struct UnifiedEnvelope: Decodable { var tasks: [SessionsFeed.UnifiedRow] }
    private struct TerminalsEnvelope: Decodable { var terminals: [SessionsFeed.TerminalRow] }
    private struct BlueprintsEnvelope: Decodable { var blueprints: [SessionsFeed.BlueprintRow] }
    private struct PodSessionsEnvelope: Decodable { var sessions: [SessionsFeed.PodSessionRow] }
    private struct AgentsEnvelope: Decodable { var agents: [SessionsFeed.AgentRow] }
    private struct HostsEnvelope: Decodable { var hosts: [SessionsFeed.HostRow] }

    /// Every source merged into one `Sources`. A failing endpoint contributes an
    /// empty list (the web `settle`s each call) so one broken kind never blanks
    /// the whole feed; only a failure of *all* of them is reported.
    func sessionsFeedSources() async throws -> SessionsFeed.Sources {
        async let unified = attempt { try await self.get("/api/tasks", query: ["type": "all", "limit": "200"], as: UnifiedEnvelope.self).tasks }
        async let terminals = attempt { try await self.get("/api/local/terminals", as: TerminalsEnvelope.self).terminals }
        async let blueprints = attempt { try await self.get("/api/local/blueprints", as: BlueprintsEnvelope.self).blueprints }
        async let sessions = attempt { try await self.get("/api/sessions", query: ["limit": "100"], as: PodSessionsEnvelope.self).sessions }
        async let agents = attempt { try await self.get("/api/persistent-agents", as: AgentsEnvelope.self).agents }
        async let hosts = attempt { try await self.get("/api/local/hosts", as: HostsEnvelope.self).hosts }

        let (u, t, b, s, a, h) = await (unified, terminals, blueprints, sessions, agents, hosts)
        let errors = [u.error, t.error, b.error, s.error, a.error, h.error]
        if let error = u.error, errors.allSatisfy({ $0 != nil }) { throw error }
        return SessionsFeed.Sources(
            unified: u.value ?? [],
            localTerminals: t.value ?? [],
            localBlueprints: b.value ?? [],
            podSessions: s.value ?? [],
            agents: a.value ?? [],
            hosts: h.value ?? []
        )
    }

    private struct Attempt<T: Sendable>: Sendable { var value: T?; var error: Error? }

    private func attempt<T: Sendable>(_ op: @Sendable () async throws -> T) async -> Attempt<T> {
        do { return Attempt(value: try await op(), error: nil) } catch { return Attempt(value: nil, error: error) }
    }
}

// MARK: - Screen state

/// Every session Optio knows about, merged from the per-kind endpoints and
/// polled while a screen holds it (`use-sessions-feed.ts`). Backs the Sessions
/// list and the Overview board.
@MainActor
@Observable
final class SessionsFeedModel {
    private(set) var rows: [SessionRow] = []
    private(set) var loading = true
    private(set) var error: Error?
    private(set) var lastRefreshed: Date?

    private let api: APIClient
    private var pollTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    var counts: SessionCounts { SessionsFeed.count(rows) }

    func rows(in view: SessionView, query: String = "") -> [SessionRow] {
        rows.filter { SessionsFeed.inView($0, view) && SessionsFeed.matches($0, query: query) }
    }

    func count(in view: SessionView) -> Int { rows.filter { SessionsFeed.inView($0, view) }.count }

    func refresh() async {
        do {
            let sources = try await api.sessionsFeedSources()
            rows = SessionsFeed.collect(sources)
            error = nil
        } catch {
            self.error = error
        }
        loading = false
        lastRefreshed = .now
    }

    /// Polls every `interval` seconds while started. Idempotent.
    func start(every interval: Double = 15) {
        guard pollTask == nil else { return }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                await self?.refresh()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    func stop() {
        pollTask?.cancel()
        pollTask = nil
    }
}
