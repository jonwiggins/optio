import Foundation

// MARK: - Row types
//
// The /api/jobs routes enrich workflow rows with aggregate run stats
// (`runCount`, `lastRunAt`, `totalCostUsd`, `triggerTypes`), so these are
// declared locally with optionals throughout.

struct JobSummary: Decodable, Identifiable, Hashable {
    let id: String
    let name: String
    let description: String?
    let promptTemplate: String?
    let paramsSchema: [String: AnyCodable]?
    let environmentSpec: [String: AnyCodable]?
    let agentRuntime: String?
    let model: String?
    let maxTurns: Int?
    let budgetUsd: String?
    let maxConcurrent: Int?
    let maxRetries: Int?
    let warmPoolSize: Int?
    let maxPodInstances: Int?
    let maxAgentsPerPod: Int?
    let enabled: Bool?
    let createdAt: Date?
    let updatedAt: Date?
    let runCount: Int?
    let lastRunAt: Date?
    let totalCostUsd: String?
    let triggerTypes: [String]?

    var isEnabled: Bool { enabled ?? true }
    var runtime: String { agentRuntime ?? "claude-code" }

    /// `{"type":"object","properties":{...}}` → field definitions for the run form.
    var paramFields: [JobParamField] {
        guard let props = paramsSchema?["properties"]?.objectValue else { return [] }
        let required = Set(paramsSchema?["required"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        return props.keys.sorted().map { key in
            let def = props[key]?.objectValue ?? [:]
            return JobParamField(
                name: key,
                type: def["type"]?.stringValue ?? "string",
                description: def["description"]?.stringValue,
                options: def["enum"]?.arrayValue?.compactMap(\.stringValue) ?? [],
                defaultValue: def["default"],
                required: required.contains(key)
            )
        }
    }
}

struct JobParamField: Identifiable, Hashable {
    let name: String
    let type: String
    let description: String?
    let options: [String]
    let defaultValue: AnyCodable?
    let required: Bool
    var id: String { name }
}

struct JobRun: Decodable, Identifiable, Hashable {
    let id: String
    let workflowId: String?
    let triggerId: String?
    let params: [String: AnyCodable]?
    let state: String
    let output: [String: AnyCodable]?
    let costUsd: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let modelUsed: String?
    let errorMessage: String?
    let sessionId: String?
    let podName: String?
    let retryCount: Int?
    let startedAt: Date?
    let finishedAt: Date?
    let createdAt: Date?
    let updatedAt: Date?

    var isActive: Bool { state == "running" || state == "queued" }
    var canRetry: Bool { state == "failed" }
    var canCancel: Bool { isActive }

    var durationText: String? {
        guard let startedAt else { return nil }
        let end = finishedAt ?? Date()
        return Self.formatDuration(end.timeIntervalSince(startedAt))
    }

    static func formatDuration(_ seconds: TimeInterval) -> String {
        let s = Int(max(0, seconds))
        if s < 60 { return "\(s)s" }
        if s < 3600 { return "\(s / 60)m \(s % 60)s" }
        return "\(s / 3600)h \((s % 3600) / 60)m"
    }

    var tokensText: String? {
        guard let inputTokens, let outputTokens else { return nil }
        return String(format: "%.1fk / %.1fk", Double(inputTokens) / 1000, Double(outputTokens) / 1000)
    }
}

struct JobTrigger: Decodable, Identifiable, Hashable {
    let id: String
    let type: String
    let config: [String: AnyCodable]?
    let paramMapping: [String: AnyCodable]?
    let enabled: Bool?
    let lastFiredAt: Date?
    let nextFireAt: Date?
    let createdAt: Date?

    var cronExpression: String? { config?["cronExpression"]?.stringValue }
    var webhookPath: String? { config?["path"]?.stringValue }
    var webhookSecret: String? { config?["secret"]?.stringValue }
}

struct JobStats: Decodable {
    let total: Int
    let queued: Int
    let running: Int
    let failed: Int
    let completed: Int
}

/// One persisted log row (`workflow_run_logs` or `task_logs`). Shared with PR
/// review logs, which come back through the same `{ logs: [...] }` envelope.
struct RunLogRow: Decodable {
    let content: String
    let logType: String?
    let metadata: [String: AnyCodable]?
    let timestamp: Date?
    let stream: String?

    var asEntry: AgentLogEntry {
        AgentLogEntry(
            taskId: "",
            timestamp: timestamp.map { RunLogRow.iso.string(from: $0) } ?? "",
            type: AgentLogEntry.TypeValue(rawValue: logType ?? "text") ?? .unknown,
            content: content,
            metadata: metadata
        )
    }

    static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
}

// MARK: - Request bodies

struct JobPayload: Encodable {
    var name: String
    var description: String?
    var enabled: Bool
    var promptTemplate: String
    var agentRuntime: String
    var model: String?
    var maxTurns: Int?
    var budgetUsd: String?
    var maxConcurrent: Int
    var maxRetries: Int
    var warmPoolSize: Int
    var maxPodInstances: Int
    var maxAgentsPerPod: Int
    var paramsSchema: [String: AnyCodable]?
}

struct TriggerPayload: Encodable {
    var type: String
    var config: [String: AnyCodable]
    var enabled: Bool
}

// MARK: - Endpoints

extension APIClient {
    struct JobListResponse: Decodable { let workflows: [JobSummary] }
    struct JobResponse: Decodable { let workflow: JobSummary }
    struct JobRunsResponse: Decodable { let runs: [JobRun] }
    struct JobRunResponse: Decodable { let run: JobRun }
    struct JobTriggersResponse: Decodable { let triggers: [JobTrigger] }
    struct JobTriggerResponse: Decodable { let trigger: JobTrigger }
    struct JobStatsResponse: Decodable { let stats: JobStats }
    struct RunLogsResponse: Decodable { let logs: [RunLogRow] }

    func listJobs() async throws -> [JobSummary] {
        try await get("/api/jobs", as: JobListResponse.self).workflows
    }

    func standaloneJobStats() async throws -> JobStats {
        try await get("/api/jobs/stats", as: JobStatsResponse.self).stats
    }

    func getJob(_ id: String) async throws -> JobSummary {
        try await get("/api/jobs/\(id)", as: JobResponse.self).workflow
    }

    func createJob(_ payload: JobPayload) async throws -> JobSummary {
        try await post("/api/jobs", body: payload, as: JobResponse.self).workflow
    }

    func updateJob(_ id: String, _ payload: JobPayload) async throws -> JobSummary {
        try await patch("/api/jobs/\(id)", body: payload, as: JobResponse.self).workflow
    }

    func setJobEnabled(_ id: String, enabled: Bool) async throws -> JobSummary {
        struct Body: Encodable { let enabled: Bool }
        return try await patch("/api/jobs/\(id)", body: Body(enabled: enabled), as: JobResponse.self).workflow
    }

    func cloneJob(_ id: String) async throws -> JobSummary {
        try await post("/api/jobs/\(id)/clone", as: JobResponse.self).workflow
    }

    func deleteJob(_ id: String) async throws {
        try await delete("/api/jobs/\(id)")
    }

    func runJob(_ id: String, params: [String: AnyCodable]?) async throws -> JobRun {
        struct Body: Encodable { let params: [String: AnyCodable]? }
        return try await post("/api/jobs/\(id)/runs", body: Body(params: params), as: JobRunResponse.self).run
    }

    func listJobRuns(_ id: String, limit: Int = 50) async throws -> [JobRun] {
        try await get("/api/jobs/\(id)/runs", query: ["limit": String(limit)], as: JobRunsResponse.self).runs
    }

    func listJobTriggers(_ id: String) async throws -> [JobTrigger] {
        try await get("/api/jobs/\(id)/triggers", as: JobTriggersResponse.self).triggers
    }

    func createJobTrigger(_ jobId: String, _ payload: TriggerPayload) async throws -> JobTrigger {
        try await post("/api/jobs/\(jobId)/triggers", body: payload, as: JobTriggerResponse.self).trigger
    }

    func updateJobTrigger(_ jobId: String, _ triggerId: String, config: [String: AnyCodable], enabled: Bool) async throws -> JobTrigger {
        struct Body: Encodable { let config: [String: AnyCodable]; let enabled: Bool }
        return try await patch("/api/jobs/\(jobId)/triggers/\(triggerId)", body: Body(config: config, enabled: enabled), as: JobTriggerResponse.self).trigger
    }

    func deleteJobTrigger(_ jobId: String, _ triggerId: String) async throws {
        try await delete("/api/jobs/\(jobId)/triggers/\(triggerId)")
    }

    func getJobRun(_ runId: String) async throws -> JobRun {
        try await get("/api/workflow-runs/\(runId)", as: JobRunResponse.self).run
    }

    func retryJobRun(_ runId: String) async throws -> JobRun {
        try await post("/api/workflow-runs/\(runId)/retry", as: JobRunResponse.self).run
    }

    func cancelJobRun(_ runId: String) async throws -> JobRun {
        try await post("/api/workflow-runs/\(runId)/cancel", as: JobRunResponse.self).run
    }

    func jobRunLogs(_ runId: String, limit: Int = 10000) async throws -> [RunLogRow] {
        try await get("/api/workflow-runs/\(runId)/logs", query: ["limit": String(limit)], as: RunLogsResponse.self).logs
    }
}

// MARK: - Small helpers shared by the Jobs + Reviews screens

enum JobFormat {
    static func cost(_ raw: String?, digits: Int = 2) -> String? { Cost.formatIfNonZero(raw) }

    static let agentRuntimes: [(String, String)] = [
        ("claude-code", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("copilot", "GitHub Copilot"),
        ("opencode", "OpenCode"),
        ("gemini", "Google Gemini"),
        ("openclaw", "OpenClaw"),
        ("cursor", "Cursor"),
    ]

    static func runtimeLabel(_ value: String) -> String {
        agentRuntimes.first { $0.0 == value }?.1 ?? value.replacingOccurrences(of: "-", with: " ").capitalized
    }

    static func triggerIcon(_ type: String) -> String {
        switch type {
        case "manual": return "hand.tap"
        case "schedule": return "clock"
        case "webhook": return "antenna.radiowaves.left.and.right"
        case "ticket": return "ticket"
        default: return "bolt"
        }
    }

    static func prettyJSON(_ dict: [String: AnyCodable]?) -> String? {
        guard let dict, !dict.isEmpty else { return nil }
        let enc = JSONEncoder()
        enc.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? enc.encode(dict) else { return nil }
        return String(decoding: data, as: UTF8.self)
    }
}
