import Foundation
import Observation

/// One sample of node metrics, collected every refresh (mirrors `MetricsHistoryPoint`).
struct MetricsSample: Identifiable, Hashable, Sendable {
    let id = UUID()
    let time: Date
    let cpuPercent: Double?
    let memoryPercent: Double?
    let pods: Int
    let agents: Int
}

/// Screen state for the Overview tab. Mirrors `apps/web/src/hooks/use-dashboard-data.ts`:
/// task stats, recent tasks, repos, hosts + terminals and the cluster fanned out
/// every 10 seconds. Usage limits come from the shared `UsageStore`; the sessions
/// board has its own `WorkFeedModel`.
@Observable
@MainActor
final class OverviewModel {
    private static let maxHistory = 60

    var taskStats: DashTaskStats?
    var recentTasks: [DashRecentTask] = []
    var repoCount: Int?
    var cluster: ClusterOverview?
    /// True when `/api/cluster/overview` answered 403 (viewer/member role).
    var clusterForbidden = false
    var metricsHistory: [MetricsSample] = []
    var loading = true
    var error: Error?
    var lastRefreshed: Date?

    /// Optio Local: paired hosts and their terminals (`local-stats.tsx`, `needs-you.tsx`).
    var localHosts: [LocalHost] = []
    var localTerminals: [LocalTerminal] = []

    var totalRecentCost: Double { recentTasks.reduce(0) { $0 + $1.cost } }
    /// A paired machine with a terminal open counts as "started", even with zero repo tasks.
    var isFirstRun: Bool { (taskStats?.total ?? 0) == 0 && localTerminals.isEmpty }

    // MARK: Local (mirrors computeLocalStats / collectNeedsYou / collectLive)

    var hasLocal: Bool { !localHosts.isEmpty || !localTerminals.isEmpty }
    var localHostName: [String: String] { Dictionary(uniqueKeysWithValues: localHosts.map { ($0.id, $0.name) }) }
    var localHostsOnline: Int { localHosts.filter { $0.state == .online }.count }

    /// Terminals waiting on the human: pinned ones first, then oldest first.
    var localNeedsYou: [LocalTerminal] {
        localTerminals.filter { LocalPresentation.waitsOnYou($0) }.sorted { a, b in
            let pa = LocalPresentation.isPinned(a), pb = LocalPresentation.isPinned(b)
            if pa != pb { return pa }
            return activity(a) < activity(b)
        }
    }

    /// Recent repo tasks that need attention (the web's `attentionTasks`).
    var attentionTasks: [DashRecentTask] {
        recentTasks.filter { Tone.forState($0.state) == .accent }
    }

    /// Keep the dashboard's attention membership/order, but share the Work card
    /// projection. Fallbacks keep cards visible while the separate feed loads.
    func needsYouRows(feed: [WorkRow]) -> [WorkRow] {
        let local = localNeedsYou.map { terminal in
            if let row = feed.first(where: { $0.source == .localTerminal && $0.sourceId == terminal.id }) { return row }
            let runtime: String
            if case .agent(let spec) = terminal.spec { runtime = spec.agent.rawValue } else { runtime = "terminal" }
            return WorkRow(
                key: "terminal-\(terminal.id)", source: .localTerminal, sourceId: terminal.id, href: "/local/\(terminal.id)",
                name: terminal.title, when: terminal.spawnedBy == .manual ? "now" : terminal.spawnedBy.rawValue,
                where: SessionWhere(target: .machine, detail: terminal.dir, hostId: terminal.hostId, dir: terminal.dir, hostName: localHostName[terminal.hostId]),
                who: runtime, then: .waitsForMe, status: .needsYou, statusLabel: LocalPresentation.waitingLabel(terminal),
                note: nil, prUrl: nil, lastActivity: terminal.lastActivityAt ?? terminal.updatedAt, recurring: false, spawned: false,
                origin: Brand(provider: terminal.ticketSource),
                links: WorkFeed.workLinks(ticketUrl: terminal.ticketUrl, ticketSource: terminal.ticketSource, ticketExternalId: terminal.ticketExternalId, scanned: terminal.links),
                pinned: LocalPresentation.isPinned(terminal)
            )
        }
        let representedTasks = Set(localNeedsYou.compactMap(\.taskId))
        let tasks = attentionTasks.filter { !representedTasks.contains($0.id) }.map { task in
            if let row = feed.first(where: { $0.source == .repoTask && $0.sourceId == task.id }) { return row }
            return WorkRow(
                key: "task-\(task.id)", source: .repoTask, sourceId: task.id, href: "/tasks/\(task.id)",
                name: task.title ?? "Task \(task.id.prefix(8))", when: "now",
                where: SessionWhere(target: .pod, detail: InsightsFormat.repoShortName(task.repoUrl ?? "")),
                who: task.agentType ?? "claude-code", then: .untilMerged, status: .needsYou, statusLabel: "needs attention",
                note: task.errorMessage, prUrl: task.prUrl, lastActivity: task.updatedAt ?? task.createdAt, recurring: false, spawned: false,
                links: WorkFeed.workLinks(ticketUrl: nil, ticketSource: nil, ticketExternalId: nil, scanned: [], prUrl: task.prUrl)
            )
        }
        return local + tasks
    }

    private func activity(_ t: LocalTerminal) -> Date {
        (t.lastActivityAt ?? t.updatedAt).isoDate ?? .distantPast
    }

    func refresh(api: APIClient) async {
        async let stats = api.dashTaskStats()
        async let tasks = Self.quiet { try await api.recentTasks(limit: 5) }
        async let repos = Self.quiet { try await api.repoCount() }
        async let hosts = Self.quiet { try await api.listLocalHosts() }
        async let terminals = Self.quiet { try await api.listLocalTerminals() }

        var clusterResult: ClusterOverview?
        var forbidden = false
        do {
            clusterResult = try await api.clusterOverview()
        } catch let e as APIError where e.status == 403 {
            forbidden = true
        } catch {
            clusterResult = nil
        }

        do {
            taskStats = try await stats
            error = nil
        } catch {
            self.error = error
        }
        if let t = await tasks { recentTasks = t }
        if let r = await repos { repoCount = r }
        if let h = await hosts { localHosts = h }
        if let t = await terminals { localTerminals = t }

        clusterForbidden = forbidden
        if let c = clusterResult {
            cluster = c
            if let node = c.nodes.first {
                let sample = MetricsSample(
                    time: .now,
                    cpuPercent: node.cpuPercent?.value,
                    memoryPercent: node.memoryPercent.map(Double.init),
                    pods: c.summary.totalPods,
                    agents: c.summary.agentPods
                )
                metricsHistory.append(sample)
                if metricsHistory.count > Self.maxHistory {
                    metricsHistory.removeFirst(metricsHistory.count - Self.maxHistory)
                }
            }
        }

        loading = false
        lastRefreshed = .now
    }

    private static func quiet<T: Sendable>(_ op: @Sendable () async throws -> T) async -> T? {
        try? await op()
    }
}
