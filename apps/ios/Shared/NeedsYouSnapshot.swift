import Foundation

/// The data every glanceable surface (widgets, Watch activity, intents) reads:
/// what needs you, what's running, and when it was computed. Built from the same
/// endpoints the app's Local hub uses so phone and web agree.
public struct NeedsYouSnapshot: Codable, Hashable, Sendable {
    public var needsYou: [WatchItem]
    public var running: [WatchItem]
    public var hostsOnline: Int
    public var hostsTotal: Int
    public var asOf: Date

    public init(needsYou: [WatchItem], running: [WatchItem], hostsOnline: Int, hostsTotal: Int, asOf: Date = .now) {
        self.needsYou = needsYou
        self.running = running
        self.hostsOnline = hostsOnline
        self.hostsTotal = hostsTotal
        self.asOf = asOf
    }

    public static let empty = NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 0, hostsTotal: 0)

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
            return WatchState(phase: .waiting, head: head, others: Array(sorted.dropFirst().prefix(2)), needsYouCount: sorted.count, runningCount: running.count, asOf: asOf)
        }
        let latest = running.sorted { $0.since > $1.since }.first
        return WatchState(phase: .working, head: latest, needsYouCount: 0, runningCount: running.count, asOf: asOf)
    }

    // MARK: - Loading from the API (local terminals; tasks/agents join in Tier 2)

    private struct HostRow: Decodable { let id: String; let state: String }
    private struct TerminalRow: Decodable {
        let id: String; let title: String; let dir: String; let state: String
        let attentionState: String?; let attentionReason: String?; let preview: String?
        let attentionChangedAt: Date?; let startedAt: Date?; let updatedAt: Date?
        let snoozedUntil: Date?
        let spec: Spec?
        struct Spec: Decodable { let kind: String }
    }
    private struct HostsEnvelope: Decodable { let hosts: [HostRow] }
    private struct TerminalsEnvelope: Decodable { let terminals: [TerminalRow] }

    struct TaskRowLite: Decodable {
        let id: String; let title: String; let state: String
        let repoBranch: String?; let repoUrl: String?; let prUrl: String?; let prNumber: Int?
        let prChecksStatus: String?; let prReviewStatus: String?; let errorMessage: String?
        let updatedAt: Date?; let startedAt: Date?; let createdAt: Date?
    }
    struct TaskEnvelope: Decodable { let task: TaskRowLite }

    /// - Parameter followed: ids of Repo Tasks the user follows ("Follow on Lock Screen");
    ///   each is fetched and joins the queue (`needs_attention`/`failed`) or the running list.
    ///   Terminal tasks (`completed`/`cancelled`) are skipped; the caller unfollows them.
    public static func load(using fetch: SharedFetch, followed: Set<String> = []) async throws -> NeedsYouSnapshot {
        async let hostsTask = fetch.get("/api/local/hosts", as: HostsEnvelope.self)
        async let termsTask = fetch.get("/api/local/terminals", query: ["state": "running"], as: TerminalsEnvelope.self)
        async let tasksTask = loadFollowedTasks(using: fetch, ids: followed)
        let (hosts, terms) = try await (hostsTask, termsTask)
        var needs: [WatchItem] = []
        var running: [WatchItem] = []
        // Agent terminals always count; a plain shell counts once the daemon has seen an
        // agent in it (attention state set by Claude Code hooks / bell scanner).
        for t in terms.terminals where t.state == "running"
            && (t.spec?.kind == "agent" || t.attentionState == "working" || t.attentionState == "needs_you") {
            let since = t.attentionChangedAt ?? t.updatedAt ?? t.startedAt ?? .now
            let item = WatchItem(
                kind: .local, id: t.id, title: t.title, mono: (t.dir as NSString).lastPathComponent,
                reason: t.attentionReason.map(Self.reasonText), preview: t.preview?.split(whereSeparator: \.isNewline).last.map(String.init),
                since: since, state: t.attentionState ?? t.state, link: DeepLink.local(t.id, compose: true).url.absoluteString,
                snoozedUntil: t.snoozedUntil)
            if t.attentionState == "needs_you" { needs.append(item) } else { running.append(item) }
        }
        let tasks = await tasksTask
        needs += tasks.needsYou
        running += tasks.running
        return NeedsYouSnapshot(needsYou: needs, running: running, hostsOnline: hosts.hosts.filter { $0.state == "online" }.count, hostsTotal: hosts.hosts.count)
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
                guard let t = row, let item = taskItem(t) else { continue }
                if t.state == "needs_attention" || t.state == "failed" { needs.append(item) } else { running.append(item) }
            }
        }
        return (needs, running)
    }

    /// Watch row for a followed task; nil when the task is finished. Copy per the brief:
    /// "Queued · branch" → "Running" → "PR #581 open · CI running" → "CI passed · review pending".
    static func taskItem(_ t: TaskRowLite) -> WatchItem? {
        switch t.state {
        case "completed", "cancelled": return nil
        default: break
        }
        let since = t.updatedAt ?? t.startedAt ?? t.createdAt ?? .now
        let mono = t.repoBranch ?? t.prNumber.map { "#\($0)" } ?? (t.repoUrl.map { ($0 as NSString).lastPathComponent } ?? "")
        return WatchItem(
            kind: .task, id: t.id, title: t.title, mono: mono, reason: taskReason(t), preview: nil,
            since: since, state: t.state, link: DeepLink.task(t.id).url.absoluteString, prUrl: t.prUrl)
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
