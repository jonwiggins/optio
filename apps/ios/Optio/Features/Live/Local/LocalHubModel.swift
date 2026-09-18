import Foundation
import Observation

/// Screen state for `/local`: hosts + terminals, refreshed on `local:changed`
/// nudges from `/ws/events` (debounced) and a 15s polling fallback.
@MainActor
@Observable
final class LocalHubModel {
    enum Filter: Hashable { case all, active, needsYou, exited }

    private(set) var hosts: [LocalHost] = []
    private(set) var terminals: [LocalTerminal] = []
    private(set) var loaded = false
    var error: Error?
    /// Transient action failure (start/kill/delete), shown as an alert.
    var actionError: String?
    var filter: Filter = .all
    var hostFilter: String?
    var search = ""

    private let api: APIClient
    private var events: WebSocketClient?
    private var eventsTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private var debounceTask: Task<Void, Never>?

    init(api: APIClient) {
        self.api = api
    }

    // MARK: Derived

    var hostById: [String: LocalHost] {
        Dictionary(uniqueKeysWithValues: hosts.map { ($0.id, $0) })
    }

    var needsYou: [LocalTerminal] {
        terminals
            .filter { $0.attentionState == .needsYou }
            .sorted { activity($0) < activity($1) }
    }

    struct Stats {
        var needsYou = 0, working = 0, idle = 0, finished = 0, hostsOnline = 0
    }

    var stats: Stats {
        var s = Stats()
        let live = terminals.filter { LocalPresentation.activeStates.contains($0.state) }
        s.needsYou = terminals.filter { $0.attentionState == .needsYou }.count
        s.working = live.filter { $0.attentionState == .working }.count
        s.idle = live.filter { $0.attentionState != .working && $0.attentionState != .needsYou }.count
        s.finished = terminals.filter { LocalPresentation.isDead($0) }.count
        s.hostsOnline = hosts.filter { $0.state == .online }.count
        return s
    }

    /// Filtered + sorted: needs_you first, then live, then finished; newest activity first within.
    var filtered: [LocalTerminal] {
        let q = search.trimmingCharacters(in: .whitespaces).lowercased()
        return terminals
            .filter { t in
                if let hostFilter, t.hostId != hostFilter { return false }
                switch filter {
                case .all: break
                case .active: if !LocalPresentation.activeStates.contains(t.state) { return false }
                case .needsYou: if t.attentionState != .needsYou { return false }
                case .exited: if !LocalPresentation.isDead(t) { return false }
                }
                if !q.isEmpty {
                    let links = LocalPresentation.workLinks(t).map { "\($0.label) \($0.url)" }.joined(separator: " ")
                    if !"\(t.title) \(t.dir) \(links)".lowercased().contains(q) { return false }
                }
                return true
            }
            .sorted { a, b in
                let ra = rank(a), rb = rank(b)
                if ra != rb { return ra < rb }
                return activity(a) > activity(b)
            }
    }

    private func rank(_ t: LocalTerminal) -> Int {
        if t.attentionState == .needsYou { return 0 }
        if LocalPresentation.activeStates.contains(t.state) { return 1 }
        return 2
    }

    private func activity(_ t: LocalTerminal) -> Date {
        (t.lastActivityAt ?? t.updatedAt).isoDate ?? .distantPast
    }

    // MARK: Loading

    func refresh() async {
        do {
            async let h = api.listLocalHosts()
            async let t = api.listLocalTerminals()
            let (hosts, terminals) = try await (h, t)
            self.hosts = hosts
            self.terminals = terminals
            error = nil
            if let hostFilter, !hosts.contains(where: { $0.id == hostFilter }) { self.hostFilter = nil }
        } catch {
            if !loaded { self.error = error }
        }
        loaded = true
    }

    /// Starts the events WebSocket and the polling fallback. Idempotent.
    func start() {
        guard eventsTask == nil else { return }
        let ws = WebSocketClient(api: api, path: "/ws/events")
        events = ws
        ws.connect()
        eventsTask = Task { [weak self] in
            for await frame in ws.frames {
                guard let self else { return }
                if case .json(let obj) = frame, obj["type"] as? String == "local:changed" {
                    self.scheduleRefresh()
                }
            }
        }
        pollTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(15))
                if Task.isCancelled { return }
                await self?.refresh()
            }
        }
    }

    func stop() {
        eventsTask?.cancel(); eventsTask = nil
        pollTask?.cancel(); pollTask = nil
        debounceTask?.cancel(); debounceTask = nil
        events?.disconnect(); events = nil
    }

    /// 500ms debounce, matching the web page.
    private func scheduleRefresh() {
        debounceTask?.cancel()
        debounceTask = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(500))
            if Task.isCancelled { return }
            await self?.refresh()
        }
    }

    // MARK: Actions

    func start(_ t: LocalTerminal) async {
        do {
            let updated = try await api.startLocalTerminal(t.id)
            replace(updated)
        } catch { actionError = error.localizedDescription }
    }

    func kill(_ t: LocalTerminal) async {
        do {
            try await api.killLocalTerminal(t.id)
            await refresh()
        } catch { actionError = error.localizedDescription }
    }

    func delete(_ t: LocalTerminal) async {
        do {
            try await api.deleteLocalTerminal(t.id)
            terminals.removeAll { $0.id == t.id }
        } catch { actionError = error.localizedDescription }
    }

    func replace(_ t: LocalTerminal) {
        if let i = terminals.firstIndex(where: { $0.id == t.id }) { terminals[i] = t } else { terminals.insert(t, at: 0) }
    }
}
