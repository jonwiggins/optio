import Foundation

// MARK: - Analytics (apps/api/src/routes/analytics.ts)

struct PerformanceDurations: Decodable, Hashable, Sendable {
    var avgWallClock: Double?
    var p50WallClock: Double?
    var p95WallClock: Double?
    var avgExecution: Double?
    var p50Execution: Double?
    var p95Execution: Double?
    var avgQueueWait: Double?
    var taskCount: Int?
}

struct TasksPerDayPoint: Decodable, Hashable, Sendable, Identifiable {
    var id: String { date }
    var date: String
    var total: Int?
    var succeeded: Int?
    var failed: Int?
}

struct PerformanceAnalytics: Decodable, Hashable, Sendable {
    var durations: PerformanceDurations?
    var successRate: Double?
    var successRateTrend: Double?
    var tasksPerDay: [TasksPerDayPoint]?
}

struct AgentModelStat: Decodable, Hashable, Sendable {
    var model: String?
    var taskCount: Int?
    var avgCost: String?
}

struct AgentAnalyticsRow: Decodable, Hashable, Sendable, Identifiable {
    var id: String { agentType ?? UUID().uuidString }
    var agentType: String?
    var taskCount: Int?
    var successRate: Double?
    var avgDuration: Double?
    var avgCost: String?
    var avgRetries: Double?
    var models: [AgentModelStat]?
}

struct AgentAnalytics: Decodable, Hashable, Sendable {
    var agents: [AgentAnalyticsRow]?
}

struct ErrorMessageCount: Decodable, Hashable, Sendable {
    var message: String
    var count: Int
}

struct FailureByRepo: Decodable, Hashable, Sendable {
    var repoUrl: String
    var total: Int?
    var failed: Int?
    var failureRate: Double?
}

struct FailureByAgent: Decodable, Hashable, Sendable {
    var agentType: String
    var total: Int?
    var failed: Int?
    var failureRate: Double?
}

struct FailureByModel: Decodable, Hashable, Sendable {
    var model: String
    var total: Int?
    var failed: Int?
    var failureRate: Double?
}

struct FailureAnalytics: Decodable, Hashable, Sendable {
    var errorMessages: [ErrorMessageCount]?
    var failureByRepo: [FailureByRepo]?
    var failureByAgent: [FailureByAgent]?
    var failureByModel: [FailureByModel]?
    var retrySuccessRate: Double?
    var retriedCount: Int?
    var retrySucceededCount: Int?
    var stallCount: Int?
    var stallRecoveryRate: Double?
}

struct PrFunnel: Decodable, Hashable, Sendable {
    var prOpened: Int?
    var ciPassed: Int?
    var reviewApproved: Int?
    var merged: Int?
}

struct PrAnalytics: Decodable, Hashable, Sendable {
    var totalPrs: Int?
    var merged: Int?
    var closed: Int?
    var open: Int?
    var ciPassRate: Double?
    var reviewApprovalRate: Double?
    var autoMergeRate: Double?
    var avgMergeTime: Double?
    var mergeCount: Int?
    var funnel: PrFunnel?
}

// MARK: - Costs

struct CostSummary: Decodable, Hashable, Sendable {
    var totalCost: String?
    var taskCount: Int?
    var tasksWithCost: Int?
    var avgCost: String?
    var costTrend: String?
    var prevPeriodCost: String?
    var days: Int?
}

struct CostForecast: Decodable, Hashable, Sendable {
    var dailyAvgCost: String?
    var monthCostSoFar: String?
    var forecastedMonthTotal: String?
    var daysRemaining: Int?
}

struct DailyCost: Decodable, Hashable, Sendable, Identifiable {
    var id: String { date }
    var date: String
    var cost: Double?
    var taskCount: Int?
}

struct CostByRepo: Decodable, Hashable, Sendable, Identifiable {
    var id: String { repoUrl }
    var repoUrl: String
    var totalCost: Double?
    var taskCount: Int?
}

struct CostByType: Decodable, Hashable, Sendable, Identifiable {
    var id: String { taskType }
    var taskType: String
    var totalCost: Double?
    var taskCount: Int?
}

struct CostByModel: Decodable, Hashable, Sendable, Identifiable {
    var id: String { model }
    var model: String
    var totalCost: Double?
    var taskCount: Int?
    var successRate: Double?
    var avgCost: Double?
    var totalInputTokens: Double?
    var totalOutputTokens: Double?
}

struct CostAnomaly: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String?
    var repoUrl: String?
    var taskType: String?
    var state: String?
    var costUsd: String?
    var modelUsed: String?
    var repoAvgCost: Double?
    var costRatio: Double?
    var createdAt: String?
}

struct ModelSuggestion: Decodable, Hashable, Sendable {
    var repoUrl: String
    var currentModel: String?
    var taskCount: Int?
    var avgCost: Double?
    var cheaperModelAvgCost: Double?
}

struct TopCostTask: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var title: String?
    var repoUrl: String?
    var taskType: String?
    var state: String?
    var costUsd: String?
    var inputTokens: Double?
    var outputTokens: Double?
    var modelUsed: String?
    var createdAt: String?
}

struct CostAnalytics: Decodable, Hashable, Sendable {
    var summary: CostSummary?
    var forecast: CostForecast?
    var dailyCosts: [DailyCost]?
    var costByRepo: [CostByRepo]?
    var costByType: [CostByType]?
    var costByModel: [CostByModel]?
    var anomalies: [CostAnomaly]?
    var modelSuggestions: [ModelSuggestion]?
    var topTasks: [TopCostTask]?
}

// MARK: - Activity (apps/api/src/routes/activity.ts)

struct ActivityActor: Decodable, Hashable, Sendable {
    var id: String?
    var displayName: String?
    var avatarUrl: String?
}

struct ActivityItem: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var type: String
    var timestamp: String
    var actor: ActivityActor?
    var action: String
    var resourceType: String
    var resourceId: String?
    var summary: String
    var details: [String: AnyCodable]?
    /// Set on items synthesized from a live `activity:new` frame (not yet in the feed).
    var isLive: Bool = false

    private enum CodingKeys: String, CodingKey { case id, type, timestamp, actor, action, resourceType, resourceId, summary, details }

    init(id: String, type: String, timestamp: String, actor: ActivityActor?, action: String, resourceType: String, resourceId: String?, summary: String, details: [String: AnyCodable]?, isLive: Bool) {
        self.id = id; self.type = type; self.timestamp = timestamp; self.actor = actor; self.action = action
        self.resourceType = resourceType; self.resourceId = resourceId; self.summary = summary; self.details = details; self.isLive = isLive
    }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        type = try c.decodeIfPresent(String.self, forKey: .type) ?? "action"
        timestamp = try c.decodeIfPresent(String.self, forKey: .timestamp) ?? ""
        actor = try? c.decodeIfPresent(ActivityActor.self, forKey: .actor)
        action = try c.decodeIfPresent(String.self, forKey: .action) ?? ""
        resourceType = try c.decodeIfPresent(String.self, forKey: .resourceType) ?? ""
        resourceId = try c.decodeIfPresent(String.self, forKey: .resourceId)
        summary = try c.decodeIfPresent(String.self, forKey: .summary) ?? ""
        details = try? c.decodeIfPresent([String: AnyCodable].self, forKey: .details)
    }
}

struct ActivityStats: Decodable, Hashable, Sendable {
    var actions = 0, taskEvents = 0, authEvents = 0, infraEvents = 0

    private enum CodingKeys: String, CodingKey { case actions, taskEvents, authEvents, infraEvents }

    init() {}

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        actions = try c.decodeIfPresent(Int.self, forKey: .actions) ?? 0
        taskEvents = try c.decodeIfPresent(Int.self, forKey: .taskEvents) ?? 0
        authEvents = try c.decodeIfPresent(Int.self, forKey: .authEvents) ?? 0
        infraEvents = try c.decodeIfPresent(Int.self, forKey: .infraEvents) ?? 0
    }
}

struct ActivityFeed: Decodable, Hashable, Sendable {
    var items: [ActivityItem]
    var total: Int
    var stats: ActivityStats?
}

// MARK: - Cluster extras

struct PodHealthEvent: Decodable, Hashable, Sendable, Identifiable {
    var id: String
    var repoPodId: String?
    var repoUrl: String?
    var eventType: String?
    var podName: String?
    var message: String?
    var createdAt: String?
}

struct K8sPodStatus: Decodable, Hashable, Sendable {
    var phase: String?
    var status: String?
    var ready: Bool?
    var restarts: Int?
    var image: String?
    var ip: String?
    var nodeName: String?
    var startedAt: String?
}

/// `GET /api/cluster/pods/:id` → the repo pod row plus live counters, its tasks, and the K8s pod.
struct RepoPodDetail: Decodable, Hashable, Sendable {
    var id: String
    var repoUrl: String?
    var repoBranch: String?
    var instanceIndex: Int?
    var podName: String?
    var podId: String?
    var state: String?
    var activeTaskCount: Int?
    var lastTaskAt: String?
    var errorMessage: String?
    var cachePvcName: String?
    var cachePvcState: String?
    var managedBy: String?
    var createdAt: String?
    var tasks: [PodTaskRow]?
    var k8sPod: K8sPodStatus?
}

struct ClusterVersion: Decodable, Hashable, Sendable {
    var current: String?
    var latest: String?
    var updateAvailable: Bool?
}

// MARK: - Endpoints

extension APIClient {
    private func analyticsQuery(days: Int, repoUrl: String? = nil, agentType: String? = nil) -> [String: String?] {
        ["days": String(days), "repoUrl": repoUrl, "agentType": agentType]
    }

    func performanceAnalytics(days: Int, repoUrl: String? = nil, agentType: String? = nil) async throws -> PerformanceAnalytics {
        try await get("/api/analytics/performance", query: analyticsQuery(days: days, repoUrl: repoUrl, agentType: agentType))
    }

    func agentAnalytics(days: Int, repoUrl: String? = nil) async throws -> AgentAnalytics {
        try await get("/api/analytics/agents", query: analyticsQuery(days: days, repoUrl: repoUrl))
    }

    func failureAnalytics(days: Int, repoUrl: String? = nil, agentType: String? = nil) async throws -> FailureAnalytics {
        try await get("/api/analytics/failures", query: analyticsQuery(days: days, repoUrl: repoUrl, agentType: agentType))
    }

    func prAnalytics(days: Int, repoUrl: String? = nil, agentType: String? = nil) async throws -> PrAnalytics {
        try await get("/api/analytics/prs", query: analyticsQuery(days: days, repoUrl: repoUrl, agentType: agentType))
    }

    func costAnalytics(days: Int, repoUrl: String? = nil) async throws -> CostAnalytics {
        try await get("/api/analytics/costs", query: analyticsQuery(days: days, repoUrl: repoUrl))
    }

    func activityFeed(days: Int, type: String? = nil, resourceType: String? = nil, limit: Int = 50, offset: Int = 0) async throws -> ActivityFeed {
        try await get("/api/activity", query: [
            "days": String(days),
            "type": type,
            "resourceType": resourceType,
            "limit": String(limit),
            "offset": String(offset),
        ])
    }

    func clusterPods() async throws -> [RepoPodRecord] {
        struct R: Decodable { var pods: [RepoPodRecord] }
        return try await get("/api/cluster/pods", as: R.self).pods
    }

    func clusterPod(id: String) async throws -> RepoPodDetail {
        struct R: Decodable { var pod: RepoPodDetail }
        return try await get("/api/cluster/pods/\(id)", as: R.self).pod
    }

    func healthEvents(limit: Int = 50) async throws -> [PodHealthEvent] {
        struct R: Decodable { var events: [PodHealthEvent] }
        return try await get("/api/cluster/health-events", query: ["limit": String(limit)], as: R.self).events
    }

    func restartClusterPod(id: String) async throws {
        try await post("/api/cluster/pods/\(id)/restart")
    }

    func clusterVersion() async throws -> ClusterVersion {
        try await get("/api/cluster/version")
    }

    /// Repo URLs for the Costs repo filter.
    func repoUrls() async throws -> [(url: String, name: String)] {
        struct Row: Decodable { var repoUrl: String?; var fullName: String? }
        struct R: Decodable { var repos: [Row] }
        return try await get("/api/repos", as: R.self).repos.compactMap { row in
            guard let url = row.repoUrl else { return nil }
            return (url, row.fullName ?? InsightsFormat.repoShortName(url))
        }
    }
}
