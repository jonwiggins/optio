import Foundation

/// The data every glanceable surface (widgets, Watch activity, intents) reads:
/// what needs you, what's running, and when it was computed. Built from the same
/// endpoints the app's Local hub uses so phone and web agree.
public struct NeedsYouSnapshot: Codable, Hashable, Sendable {
    public var needsYou: [WatchItem]
    public var running: [WatchItem]
    public var hostsOnline: Int
    public var hostsTotal: Int
    /// The session board tiles the items alone cannot tell (`GET /api/glance/watch`);
    /// nil when the server predates the endpoint or the call failed.
    public var counts: SessionTileCounts?
    public var asOf: Date

    public init(needsYou: [WatchItem], running: [WatchItem], hostsOnline: Int, hostsTotal: Int, counts: SessionTileCounts? = nil, asOf: Date = .now) {
        self.needsYou = needsYou
        self.running = running
        self.hostsOnline = hostsOnline
        self.hostsTotal = hostsTotal
        self.counts = counts
        self.asOf = asOf
    }

    public static let empty = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 0, hostsTotal: 0)

    /// Fold another server's snapshot into this one (items concatenated, hosts and tiles summed).
    public mutating func merge(_ other: NeedsYouSnapshot) {
        needsYou += other.needsYou
        running += other.running
        hostsOnline += other.hostsOnline
        hostsTotal += other.hostsTotal
        counts = SessionTileCounts.sum(counts, other.counts)
    }

    /// Derives the Watch content state per the product brief: oldest needs-you item
    /// first, up to two more listed, counts for the rest.
    public func watchState() -> WatchState {
        if hostsTotal > 0, hostsOnline == 0 {
            return WatchState(phase: .offline, head: needsYou.first, needsYouCount: needsYou.count, runningCount: running.count, offlineSince: asOf, asOf: asOf)
        }
        // Oldest first; anything under a "Later" window drops behind everything that isn't.
        let now = asOf
        let sorted = needsYou.sorted {
            let (a, b) = ($0.isSnoozed(at: now), $1.isSnoozed(at: now))
            return a == b ? $0.since < $1.since : !a
        }
        if let head = sorted.first {
            return WatchState(phase: .waiting, head: head, others: Array(sorted.dropFirst().prefix(2)), needsYouCount: sorted.count, runningCount: running.count,
                              waitingCount: counts?.waiting, recurringCount: counts?.recurring, agentCount: counts?.agents, asOf: asOf)
        }
        let latest = running.sorted { $0.since > $1.since }.first
        return WatchState(phase: .working, head: latest, needsYouCount: 0, runningCount: running.count,
                          waitingCount: counts?.waiting, recurringCount: counts?.recurring, agentCount: counts?.agents, asOf: asOf)
    }

    // MARK: - Loading from the API (local terminals; tasks/agents join in Tier 2)

    private struct HostRow: Decodable { let id: String; let name: String?; let state: String }
    private struct TerminalRow: Decodable {
        let id: String; let title: String; let dir: String; let state: String
        let hostId: String?; let spawnedBy: String?
        let attentionState: String?; let attentionReason: String?; let preview: String?
        let attentionChangedAt: Date?; let startedAt: Date?; let updatedAt: Date?
        let snoozedUntil: Date?
        let spec: Spec?
        struct Spec: Decodable { let kind: String; let agent: String?; let mode: String? }
    }
    private struct HostsEnvelope: Decodable { let hosts: [HostRow] }
    private struct TerminalsEnvelope: Decodable { let terminals: [TerminalRow] }
    /// Only the tiles are read from the server's Watch frame; items come from the lists above.
    private struct WatchTiles: Decodable { let waitingCount: Int?; let recurringCount: Int?; let agentCount: Int? }

    struct TaskRowLite: Decodable {
        let id: String; let title: String; let state: String
        let repoBranch: String?; let repoUrl: String?; let prUrl: String?; let prNumber: Int?
        let prChecksStatus: String?; let prReviewStatus: String?; let errorMessage: String?
        let agentType: String?; let runTarget: String?; let localDir: String?
        let metadata: Metadata?
        let updatedAt: Date?; let startedAt: Date?; let createdAt: Date?
        struct Metadata: Decodable { let taskConfigId: String? }
    }
    struct TaskEnvelope: Decodable { let task: TaskRowLite }

    /// `/Users/me/repos/x` → `~/repos/x` (sessions-feed `shortDir`).
    static func shortDir(_ dir: String) -> String {
        for prefix in ["/Users/", "/home/"] where dir.hasPrefix(prefix) {
            let rest = dir.dropFirst(prefix.count)
            if let slash = rest.firstIndex(of: "/") { return "~" + rest[slash...] }
            return "~"
        }
        return dir
    }

    /// `https://github.com/o/r.git` → `o/r` (sessions-feed `shortRepo`).
    static func shortRepo(_ url: String?) -> String? {
        guard var s = url, !s.isEmpty else { return nil }
        if let range = s.range(of: "://") {
            s = String(s[range.upperBound...])
            if let slash = s.firstIndex(of: "/") { s = String(s[s.index(after: slash)...]) }
        }
        if s.hasSuffix(".git") { s.removeLast(4) }
        return s
    }

    /// Status word for a terminal (sessions-feed `terminalStatus`).
    static func terminalStatusLabel(state: String, attentionState: String?) -> String {
        switch state {
        case "error": return "error"
        case "exited": return "exited"
        case "pending": return "pending"
        default:
            if attentionState == "needs_you" { return "needs you" }
            if attentionState == "idle" { return "idle" }
            return "working"
        }
    }

    /// Status word for a task (sessions-feed `taskStatus`).
    static func taskStatusLabel(_ state: String) -> String {
        switch state {
        case "needs_attention": return "needs attention"
        case "pr_opened": return "PR open"
        default: return state.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// - Parameter followed: ids of Repo Tasks the user follows ("Follow on Lock Screen");
    ///   each is fetched and joins the queue (`needs_attention`/`failed`) or the running list.
    ///   Terminal tasks (`completed`/`cancelled`) are skipped; the caller unfollows them.
    public static func load(using fetch: SharedFetch, followed: Set<String> = []) async throws -> NeedsYouSnapshot {
        async let hostsTask = fetch.get("/api/local/hosts", as: HostsEnvelope.self)
        async let termsTask = fetch.get("/api/local/terminals", query: ["state": "running"], as: TerminalsEnvelope.self)
        async let tasksTask = loadFollowedTasks(using: fetch, ids: followed)
        // Board tiles from the server's Watch frame; older servers 404 → nil (tiles hide).
        async let tilesTask: WatchTiles? = try? fetch.get("/api/glance/watch", as: WatchTiles.self)
        let (hosts, terms) = try await (hostsTask, termsTask)
        let hostName = Dictionary(hosts.hosts.compactMap { h in h.name.map { (h.id, $0) } }, uniquingKeysWith: { a, _ in a })
        var needs: [WatchItem] = []
        var running: [WatchItem] = []
        // Agent terminals always count; a plain shell counts once the daemon has seen an
        // agent in it (attention state set by Claude Code hooks / bell scanner).
        for t in terms.terminals where t.state == "running"
            && (t.spec?.kind == "agent" || t.attentionState == "working" || t.attentionState == "needs_you") {
            let since = t.attentionChangedAt ?? t.updatedAt ?? t.startedAt ?? .now
            let agent = t.spec?.kind == "agent" ? (t.spec?.agent ?? "claude-code") : "terminal"
            let detail = [t.hostId.flatMap { hostName[$0] }, Self.shortDir(t.dir)].compactMap { $0 }.joined(separator: " · ")
            let item = WatchItem(
                kind: .local, id: t.id, title: t.title, mono: (t.dir as NSString).lastPathComponent,
                reason: t.attentionReason.map(Self.reasonText), preview: t.preview?.split(whereSeparator: \.isNewline).last.map(String.init),
                since: since, state: t.attentionState ?? t.state, link: DeepLink.local(t.id, compose: true).url(server: fetch.serverId).absoluteString,
                snoozedUntil: t.snoozedUntil, serverId: fetch.serverId, serverName: fetch.serverName,
                source: .localTerminal,
                when: (t.spawnedBy ?? "manual") == "manual" ? "now" : t.spawnedBy,
                where: WatchWhere(target: .machine, detail: detail.isEmpty ? nil : detail),
                who: agent,
                then: (t.spec?.kind == "agent" && t.spec?.mode == "headless") ? .exits : .waitsForMe,
                statusLabel: Self.terminalStatusLabel(state: t.state, attentionState: t.attentionState))
            if t.attentionState == "needs_you" { needs.append(item) } else { running.append(item) }
        }
        let tasks = await tasksTask
        needs += tasks.needsYou
        running += tasks.running
        let tiles = await tilesTask
        let counts = tiles.flatMap { t -> SessionTileCounts? in
            guard t.waitingCount != nil || t.recurringCount != nil || t.agentCount != nil else { return nil }
            return SessionTileCounts(waiting: t.waitingCount ?? 0, recurring: t.recurringCount ?? 0, agents: t.agentCount ?? 0)
        }
        return NeedsYouSnapshot(needsYou: needs, running: running, hostsOnline: hosts.hosts.filter { $0.state == "online" }.count, hostsTotal: hosts.hosts.count, counts: counts)
    }

    /// Every paired server merged into one snapshot. Servers that fail are skipped;
    /// throws only when none answered. Host counts sum across servers.
    public static func loadAll(followed: Set<String> = []) async throws -> (snapshot: NeedsYouSnapshot, failed: [String]) {
        let clients = SharedFetch.allServers
        guard !clients.isEmpty else { throw SharedFetch.Failure(status: 0, message: "no servers") }
        var merged = NeedsYouSnapshot.empty
        var any = false
        var failed: [String] = []
        var lastError: Error?
        await withTaskGroup(of: (String?, Result<NeedsYouSnapshot, Error>).self) { group in
            for c in clients {
                group.addTask {
                    do { return (c.serverId, .success(try await load(using: c, followed: followed))) } catch { return (c.serverId, .failure(error)) }
                }
            }
            for await (id, r) in group {
                switch r {
                case .success(let s):
                    any = true
                    merged.merge(s)
                case .failure(let e):
                    lastError = e
                    if let id { failed.append(id) }
                }
            }
        }
        guard any else { throw lastError ?? SharedFetch.Failure(status: 0, message: "unreachable") }
        merged.asOf = .now
        return (merged, failed)
    }

    /// Followed tasks, split like terminals. Failures per task are ignored (a deleted
    /// task simply disappears from the Watch).
    static func loadFollowedTasks(using fetch: SharedFetch, ids: Set<String>) async -> (needsYou: [WatchItem], running: [WatchItem]) {
        guard !ids.isEmpty else { return ([], []) }
        var needs: [WatchItem] = []
        var running: [WatchItem] = []
        await withTaskGroup(of: TaskRowLite?.self) { group in
            for id in ids { group.addTask { try? await fetch.get("/api/tasks/\(id)", as: TaskEnvelope.self).task } }
            for await row in group {
                guard let t = row, let item = taskItem(t, server: fetch) else { continue }
                if t.state == "needs_attention" || t.state == "failed" { needs.append(item) } else { running.append(item) }
            }
        }
        return (needs, running)
    }

    /// Watch row for a followed task; nil when the task is finished. Copy per the brief:
    /// "Queued · branch" → "Running" → "PR #581 open · CI running" → "CI passed · review pending".
    static func taskItem(_ t: TaskRowLite, server: SharedFetch? = nil) -> WatchItem? {
        switch t.state {
        case "completed", "cancelled": return nil
        default: break
        }
        let since = t.updatedAt ?? t.startedAt ?? t.createdAt ?? .now
        let mono = t.repoBranch ?? t.prNumber.map { "#\($0)" } ?? (t.repoUrl.map { ($0 as NSString).lastPathComponent } ?? "")
        let local = t.runTarget == "local"
        return WatchItem(
            kind: .task, id: t.id, title: t.title, mono: mono, reason: taskReason(t), preview: nil,
            since: since, state: t.state, link: DeepLink.task(t.id).url(server: server?.serverId).absoluteString, prUrl: t.prUrl,
            serverId: server?.serverId, serverName: server?.serverName,
            source: .repoTask,
            when: t.metadata?.taskConfigId != nil ? "on a trigger" : "now",
            where: local ? WatchWhere(target: .machine, detail: t.localDir.map(shortDir)) : WatchWhere(target: .pod, detail: shortRepo(t.repoUrl)),
            who: t.agentType ?? "claude-code",
            then: .exits,
            statusLabel: taskStatusLabel(t.state))
    }

    static func taskReason(_ t: TaskRowLite) -> String? {
        switch t.state {
        case "needs_attention":
            if let e = t.errorMessage, e.lowercased().contains("conflict") { return "Merge conflict — resume?" }
            return t.errorMessage.map { String($0.prefix(80)) } ?? "Needs attention — resume?"
        case "failed": return t.errorMessage.map { String($0.prefix(80)) } ?? "Failed — retry?"
        case "pr_opened":
            let pr = t.prNumber.map { "PR #\($0)" } ?? "PR"
            switch t.prChecksStatus {
            case "passing": return "\(pr) · CI passed · review \(t.prReviewStatus == "approved" ? "approved" : "pending")"
            case "failing": return "\(pr) · CI failing"
            default: return "\(pr) open · CI running"
            }
        case "queued", "pending": return "Queued"
        case "provisioning": return "Starting"
        case "running": return "Running"
        default: return t.state.replacingOccurrences(of: "_", with: " ")
        }
    }

    static func reasonText(_ raw: String) -> String {
        switch raw {
        case "notification": return "Waiting on a permission"
        case "stop": return "Claude stopped — reply to continue"
        case "quiet", "silence": return "Gone quiet"
        default: return raw.replacingOccurrences(of: "_", with: " ")
        }
    }
}

/// The three board tiles the items alone cannot tell (`countSessions` on the web).
public struct SessionTileCounts: Codable, Hashable, Sendable {
    public var waiting: Int
    public var recurring: Int
    public var agents: Int

    public init(waiting: Int, recurring: Int, agents: Int) {
        self.waiting = waiting
        self.recurring = recurring
        self.agents = agents
    }

    /// Sum across servers; nil only when neither side has tiles.
    public static func sum(_ a: SessionTileCounts?, _ b: SessionTileCounts?) -> SessionTileCounts? {
        switch (a, b) {
        case (nil, nil): return nil
        case (let x?, nil): return x
        case (nil, let y?): return y
        case (let x?, let y?): return SessionTileCounts(waiting: x.waiting + y.waiting, recurring: x.recurring + y.recurring, agents: x.agents + y.agents)
        }
    }
}
