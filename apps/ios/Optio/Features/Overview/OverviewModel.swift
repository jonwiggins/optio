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
/// board has its own `SessionsFeedModel`.
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

    /// Terminals waiting on the human, oldest first.
    var localNeedsYou: [LocalTerminal] {
        localTerminals.filter { LocalPresentation.waitsOnYou($0) }.sorted { activity($0) < activity($1) }
    }

    /// Recent repo tasks that need attention (the web's `attentionTasks`).
    var attentionTasks: [DashRecentTask] {
        recentTasks.filter { Tone.forState($0.state) == .accent }
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
