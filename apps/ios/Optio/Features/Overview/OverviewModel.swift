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
/// eight requests fanned out every 10 seconds, plus usage/auth every 5 minutes.
@Observable
@MainActor
final class OverviewModel {
    private static let maxHistory = 60

    var taskStats: DashTaskStats?
    var standaloneStats: DashJobStats?
    var agentStats: DashAgentStats?
    var sessionStats: DashSessionStats?
    var recentTasks: [DashRecentTask] = []
    var repoCount: Int?
    var cluster: ClusterOverview?
    /// True when `/api/cluster/overview` answered 403 (viewer/member role).
    var clusterForbidden = false
    var activeSessions: [DashSessionRow] = []
    var activeSessionCount = 0
    var usage: ClaudeUsageData?
    var metricsHistory: [MetricsSample] = []
    var loading = true
    var error: Error?
    var lastRefreshed: Date?

    private var lastUsageRefresh: Date?

    var totalRecentCost: Double { recentTasks.reduce(0) { $0 + $1.cost } }
    var isFirstRun: Bool { (taskStats?.total ?? 0) == 0 }

    func refresh(api: APIClient) async {
        async let stats = api.dashTaskStats()
        async let tasks = Self.quiet { try await api.recentTasks(limit: 5) }
        async let repos = Self.quiet { try await api.repoCount() }
        async let sessions = Self.quiet { try await api.activeSessions(limit: 5) }
        async let jobs = Self.quiet { try await api.dashJobStats() }
        async let agents = Self.quiet { try await api.dashAgentStats() }
        async let sessStats = Self.quiet { try await api.dashSessionStats() }

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
        if let s = await sessions {
            activeSessions = s.sessions
            activeSessionCount = s.activeCount
        }
        standaloneStats = await jobs
        agentStats = await agents
        sessionStats = await sessStats

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

        if lastUsageRefresh == nil || Date.now.timeIntervalSince(lastUsageRefresh!) > 5 * 60 {
            await refreshUsage(api: api)
        }
        loading = false
        lastRefreshed = .now
    }

    /// Mirrors `refreshUsage` in the web hook: an unavailable-without-error usage
    /// response (or a failed usage call) is cross-checked against `/api/auth/status`
    /// so an expired OAuth token surfaces as a banner.
    func refreshUsage(api: APIClient) async {
        lastUsageRefresh = .now
        do {
            let u = try await api.dashUsage()
            if !u.available, u.error == nil {
                if let status = try? await api.dashAuthStatus(), status.subscription?.expired == true {
                    usage = ClaudeUsageData(available: false, error: "OAuth token has expired")
                    return
                }
            }
            usage = u
        } catch {
            if let status = try? await api.dashAuthStatus(), status.subscription?.expired == true {
                usage = ClaudeUsageData(available: false, error: "OAuth token has expired")
            }
        }
    }

    private static func quiet<T: Sendable>(_ op: @Sendable () async throws -> T) async -> T? {
        try? await op()
    }
}
