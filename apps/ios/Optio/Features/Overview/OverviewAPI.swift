import Foundation

// MARK: - Loose decoding helpers

/// A number that the server may send as a JSON number or a numeric string
/// (e.g. cluster `memoryUsedGi` is a string, `cpuPercent` a number).
struct LooseDouble: Decodable, Hashable, Sendable {
    let value: Double?

    init(_ value: Double?) { self.value = value }

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() {
            value = nil
        } else if let d = try? c.decode(Double.self) {
            value = d
        } else if let s = try? c.decode(String.self) {
            value = Double(s)
        } else {
            value = nil
        }
    }
}

// MARK: - Dashboard stats (apps/web/src/components/dashboard/types.ts)

struct DashTaskStats: Decodable, Hashable, Sendable {
    var total = 0, queued = 0, running = 0, ci = 0, review = 0, needsAttention = 0, failed = 0, completed = 0

    private enum CodingKeys: String, CodingKey { case total, queued, running, ci, review, needsAttention, failed, completed }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        total = try c.decodeIfPresent(Int.self, forKey: .total) ?? 0
        queued = try c.decodeIfPresent(Int.self, forKey: .queued) ?? 0
        running = try c.decodeIfPresent(Int.self, forKey: .running) ?? 0
        ci = try c.decodeIfPresent(Int.self, forKey: .ci) ?? 0
        review = try c.decodeIfPresent(Int.self, forKey: .review) ?? 0
        needsAttention = try c.decodeIfPresent(Int.self, forKey: .needsAttention) ?? 0
        failed = try c.decodeIfPresent(Int.self, forKey: .failed) ?? 0
        completed = try c.decodeIfPresent(Int.self, forKey: .completed) ?? 0
    }
}

// MARK: - Claude usage / auth status

struct UsageWindow: Decodable, Hashable, Sendable {
    var utilization: Double?
    var resetsAt: String?
}

struct ExtraUsage: Decodable, Hashable, Sendable {
    var isEnabled: Bool?
    var monthlyLimit: Double?
    var usedCredits: Double?
    var utilization: Double?
}

struct AuthFailures: Decodable, Hashable, Sendable {
    var claude: Bool?
    var github: Bool?
}

struct ClaudeUsageData: Decodable, Hashable, Sendable {
    var available: Bool = false
    var error: String?
    var hasRecentAuthFailure: Bool?
    var authFailures: AuthFailures?
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var sevenDaySonnet: UsageWindow?
    var sevenDayOpus: UsageWindow?
    var extraUsage: ExtraUsage?

    private enum CodingKeys: String, CodingKey {
        case available, error, hasRecentAuthFailure, authFailures, fiveHour, sevenDay, sevenDaySonnet, sevenDayOpus, extraUsage
    }

    init(available: Bool, error: String? = nil) {
        self.available = available
        self.error = error
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        available = try c.decodeIfPresent(Bool.self, forKey: .available) ?? false
        error = try c.decodeIfPresent(String.self, forKey: .error)
        hasRecentAuthFailure = try c.decodeIfPresent(Bool.self, forKey: .hasRecentAuthFailure)
        authFailures = try c.decodeIfPresent(AuthFailures.self, forKey: .authFailures)
        fiveHour = try c.decodeIfPresent(UsageWindow.self, forKey: .fiveHour)
        sevenDay = try c.decodeIfPresent(UsageWindow.self, forKey: .sevenDay)
        sevenDaySonnet = try c.decodeIfPresent(UsageWindow.self, forKey: .sevenDaySonnet)
        sevenDayOpus = try c.decodeIfPresent(UsageWindow.self, forKey: .sevenDayOpus)
        extraUsage = try c.decodeIfPresent(ExtraUsage.self, forKey: .extraUsage)
    }

    /// Mirrors `UsagePanel`'s Claude-failure detection.
    var claudeAuthFailed: Bool {
        if let c = authFailures?.claude { return c }
        if hasRecentAuthFailure == true { return true }
        if !available, let error {
            return error.contains("401") || error.lowercased().contains("expired")
        }
        return false
    }

    var githubAuthFailed: Bool { authFailures?.github ?? false }
}

struct AuthSubscriptionStatus: Decodable, Hashable, Sendable {
    var available: Bool?
    var expiresAt: String?
    var error: String?
    var expired: Bool?
    var lastValidated: String?
}

struct DashAuthStatus: Decodable, Hashable, Sendable {
    var subscription: AuthSubscriptionStatus?
}

// MARK: - Cluster overview (apps/api/src/routes/cluster.ts)

struct ClusterNode: Decodable, Hashable, Sendable, Identifiable {
    var id: String { name }
    var name: String
    var status: String?
    var kubeletVersion: String?
    var os: String?
    var arch: String?
    var cpu: LooseDouble?
    var memory: String?
    var containerRuntime: String?
    var cpuPercent: LooseDouble?
    var memoryUsedGi: LooseDouble?
    var memoryTotalGi: LooseDouble?

    var isReady: Bool { status == "Ready" }
    var memoryPercent: Int? {
        guard let used = memoryUsedGi?.value, let total = memoryTotalGi?.value, total > 0 else { return nil }
        return Int((used / total * 100).rounded())
    }
}

struct ClusterPodInfo: Decodable, Hashable, Sendable, Identifiable {
    var id: String { name }
    var name: String
    var phase: String?
    var status: String?
    var ready: Bool?
    var restarts: Int?
    var image: String?
    var nodeName: String?
    var ip: String?
    var startedAt: String?
    var isOptioManaged: Bool?
    var isInfra: Bool?
    var cpuMillicores: Int?
    var memoryMi: Int?

    var shortImage: String? { image?.split(separator: "/").last.map(String.init) }
}

struct ClusterServicePort: Decodable, Hashable, Sendable {
    var port: Int?
    var targetPort: LooseDouble?
    var proto: String?

    private enum CodingKeys: String, CodingKey { case port, targetPort, proto = "protocol" }
}

struct ClusterService: Decodable, Hashable, Sendable, Identifiable {
    var id: String { name ?? UUID().uuidString }
    var name: String?
    var type: String?
    var clusterIP: String?
    var ports: [ClusterServicePort]?
}

struct ClusterEvent: Decodable, Hashable, Sendable {
    var type: String?
    var reason: String?
    var message: String?
    var involvedObject: String?
    var count: Int?
    var lastTimestamp: String?
}

/// A `repo_pods` row as the cluster routes return it (enriched with live counters).
struct RepoPodRecord: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var repoUrl: String?
    var repoBranch: String?
    var instanceIndex: Int?
    var podName: String?
    var podId: String?
    var state: String?
    var activeTaskCount: Int?
    var queuedTaskCount: Int?
    var maxConcurrentTasks: Int?
    var maxPodInstances: Int?
    var maxAgentsPerPod: Int?
    var lastTaskAt: String?
    var errorMessage: String?
    var cachePvcName: String?
    var cachePvcState: String?
    var managedBy: String?
    var createdAt: String?
    var updatedAt: String?
    var recentTasks: [PodTaskRow]?
}

struct ClusterSummary: Decodable, Hashable, Sendable {
    var totalPods = 0, runningPods = 0, agentPods = 0, infraPods = 0, totalNodes = 0, readyNodes = 0

    private enum CodingKeys: String, CodingKey { case totalPods, runningPods, agentPods, infraPods, totalNodes, readyNodes }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        totalPods = try c.decodeIfPresent(Int.self, forKey: .totalPods) ?? 0
        runningPods = try c.decodeIfPresent(Int.self, forKey: .runningPods) ?? 0
        agentPods = try c.decodeIfPresent(Int.self, forKey: .agentPods) ?? 0
        infraPods = try c.decodeIfPresent(Int.self, forKey: .infraPods) ?? 0
        totalNodes = try c.decodeIfPresent(Int.self, forKey: .totalNodes) ?? 0
        readyNodes = try c.decodeIfPresent(Int.self, forKey: .readyNodes) ?? 0
    }
}

struct ClusterOverview: Decodable, Hashable, Sendable {
    var nodes: [ClusterNode] = []
    var pods: [ClusterPodInfo] = []
    var services: [ClusterService] = []
    var events: [ClusterEvent] = []
    var repoPods: [RepoPodRecord] = []
    var metricsAvailable: Bool?
    var summary = ClusterSummary()

    private enum CodingKeys: String, CodingKey { case nodes, pods, services, events, repoPods, metricsAvailable, summary }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        nodes = try c.decodeIfPresent([ClusterNode].self, forKey: .nodes) ?? []
        pods = try c.decodeIfPresent([ClusterPodInfo].self, forKey: .pods) ?? []
        services = try c.decodeIfPresent([ClusterService].self, forKey: .services) ?? []
        events = try c.decodeIfPresent([ClusterEvent].self, forKey: .events) ?? []
        repoPods = try c.decodeIfPresent([RepoPodRecord].self, forKey: .repoPods) ?? []
        metricsAvailable = try c.decodeIfPresent(Bool.self, forKey: .metricsAvailable)
        summary = try c.decodeIfPresent(ClusterSummary.self, forKey: .summary) ?? ClusterSummary()
    }
}

/// A task row as `/api/cluster/pods*` embed it (subset of `tasks`).
struct PodTaskRow: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String?
    var state: String?
    var agentType: String?
    var createdAt: String?
}

// MARK: - Recent tasks / sessions (routes enrich rows, so keep these loose)

struct DashRecentTask: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String?
    var state: String?
    var repoUrl: String?
    var repoBranch: String?
    var agentType: String?
    var prUrl: String?
    var costUsd: String?
    var errorMessage: String?
    var resultSummary: String?
    var createdAt: String?
    var updatedAt: String?

    var cost: Double { Double(costUsd ?? "") ?? 0 }
}

// MARK: - Endpoints

extension APIClient {
    func dashTaskStats() async throws -> DashTaskStats {
        struct R: Decodable { var stats: DashTaskStats }
        return try await get("/api/tasks/stats", as: R.self).stats
    }

    func recentTasks(limit: Int = 5) async throws -> [DashRecentTask] {
        struct R: Decodable { var tasks: [DashRecentTask] }
        return try await get("/api/tasks", query: ["limit": String(limit)], as: R.self).tasks
    }

    func repoCount() async throws -> Int {
        struct Row: Decodable { var id: String? }
        struct R: Decodable { var repos: [Row] }
        return try await get("/api/repos", as: R.self).repos.count
    }

    func clusterOverview() async throws -> ClusterOverview {
        try await get("/api/cluster/overview")
    }

    func dashUsage() async throws -> ClaudeUsageData {
        struct R: Decodable { var usage: ClaudeUsageData }
        return try await get("/api/usage", as: R.self).usage
    }

    func dashAuthStatus() async throws -> DashAuthStatus {
        try await get("/api/auth/status")
    }
}
