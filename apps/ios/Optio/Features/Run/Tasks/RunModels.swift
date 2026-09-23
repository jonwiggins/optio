import Foundation

// Row shapes returned by the task-related routes. Routes enrich rows beyond the
// generated `OptioTask` (prNumber, prChecksStatus, costUsd, isStalled, …), and
// several fields are nullable in practice, so these are declared locally with
// everything optional. See apps/api/src/schemas/task.ts.

struct TaskRow: Decodable, Identifiable, Hashable {
    let id: String
    var title: String
    var prompt: String?
    var repoUrl: String?
    var repoBranch: String?
    var state: String
    var agentType: String?
    var sessionId: String?
    var prUrl: String?
    var prNumber: Int?
    var prState: String?
    var prChecksStatus: String?
    var prReviewStatus: String?
    var resultSummary: String?
    var costUsd: String?
    var inputTokens: Int?
    var outputTokens: Int?
    var modelUsed: String?
    var errorMessage: String?
    var ticketSource: String?
    var ticketExternalId: String?
    var retryCount: Int?
    var maxRetries: Int?
    var priority: Int?
    var parentTaskId: String?
    var taskType: String?
    var blocksParent: Bool?
    var isStalled: Bool?
    var pendingReason: String?
    var lastActivityAt: Date?
    var activitySubstate: String?
    var createdAt: Date?
    var updatedAt: Date?
    var startedAt: Date?
    var completedAt: Date?

    var taskState: TaskState { TaskState(rawValue: state) ?? .unknown }
    var repoShortName: String { RunFormatting.repoShortName(repoUrl ?? "") }
    var prLabel: String? {
        guard prUrl != nil else { return nil }
        if let prNumber { return "PR #\(prNumber)" }
        if let n = prUrl?.split(separator: "/").last { return "PR #\(n)" }
        return "PR"
    }
    var costText: String? {
        guard let costUsd, let v = Double(costUsd) else { return nil }
        return Cost.format(v)
    }
}

struct RunTaskStats: Decodable {
    var total: Int = 0
    var queued: Int = 0
    var running: Int = 0
    var ci: Int = 0
    var review: Int = 0
    var needsAttention: Int = 0
    var failed: Int = 0
    var completed: Int = 0
}

/// Row from `GET /api/tasks/:id/logs` (schemas/task.ts LogEntrySchema).
struct TaskLogRow: Decodable {
    var id: String?
    var stream: String?
    var content: String
    var logType: String?
    var metadata: [String: AnyCodable]?
    var timestamp: String?

    func asEntry(taskId: String) -> AgentLogEntry {
        AgentLogEntry(
            taskId: taskId,
            timestamp: timestamp ?? "",
            type: AgentLogEntry.TypeValue(rawValue: logType ?? "text") ?? .text,
            content: content,
            metadata: metadata
        )
    }
}

/// Frame from `/ws/logs/:taskId` (ws/log-stream.ts). The generated `TaskLogEvent`
/// omits `logType`/`metadata`/`catchUp`, which the log renderer needs.
struct TaskLogFrame: Decodable {
    var type: String
    var taskId: String?
    var content: String?
    var stream: String?
    var timestamp: String?
    var logType: String?
    var metadata: [String: AnyCodable]?
    var catchUp: Bool?
}

/// Item from `GET /api/tasks/:id/activity` — comments, events and messages merged.
struct TaskActivityItem: Decodable, Identifiable {
    struct User: Decodable { var id: String?; var displayName: String?; var avatarUrl: String? }
    var type: String
    var id: String
    var taskId: String?
    var createdAt: Date?
    var content: String?
    var user: User?
    var fromState: String?
    var toState: String?
    var trigger: String?
    var message: String?
    var userId: String?
    var mode: String?
    var deliveredAt: Date?
    var ackedAt: Date?
}

struct RunRepoRow: Decodable, Identifiable, Hashable {
    let id: String
    var repoUrl: String
    var fullName: String?
    var defaultBranch: String?
    var defaultAgentType: String?
    var displayName: String { fullName ?? RunFormatting.repoShortName(repoUrl) }
}

struct RunPromptTemplateRow: Decodable, Identifiable, Hashable {
    let id: String
    var name: String
    var template: String
    var kind: String?
    var description: String?
    var defaultAgentType: String?
}

/// Trigger row shared by task-configs and the unified /api/tasks/:id/triggers routes.
struct TriggerRow: Decodable, Identifiable, Hashable {
    let id: String
    var targetType: String?
    var targetId: String?
    var type: String
    var config: [String: AnyCodable]?
    var paramMapping: [String: AnyCodable]?
    var enabled: Bool
    var lastFiredAt: Date?
    var nextFireAt: Date?
    var createdAt: Date?

    var cronExpression: String? { config?["cronExpression"]?.stringValue }
    var webhookPath: String? { config?["path"]?.stringValue }
    var ticketSource: String? { config?["source"]?.stringValue }
    var ticketLabels: [String] { config?["labels"]?.arrayValue?.compactMap { $0.stringValue } ?? [] }

    var summary: String {
        switch type {
        case "schedule": return cronExpression ?? "cron"
        case "webhook": return webhookPath.map { "/api/hooks/\($0)" } ?? "webhook"
        case "ticket":
            let src = ticketSource ?? "github"
            return ticketLabels.isEmpty ? src : "\(src) · \(ticketLabels.joined(separator: ", "))"
        default: return "manual"
        }
    }
}

struct TaskConfigRow: Decodable, Identifiable, Hashable {
    let id: String
    var name: String
    var description: String?
    var title: String
    var prompt: String
    var promptTemplateId: String?
    var repoUrl: String
    var repoBranch: String?
    var agentType: String?
    var maxRetries: Int?
    var priority: Int?
    var enabled: Bool
    var createdAt: Date?
    var updatedAt: Date?
}

/// Row from `GET /api/issues`. Shape varies by provider (schemas/session.ts).
struct IssueRow: Decodable, Identifiable {
    struct Repo: Decodable { var id: String?; var fullName: String?; var repoUrl: String? }
    struct OptioTaskRef: Decodable { var taskId: String?; var state: String? }
    var id: AnyCodable?
    var number: AnyCodable?
    var title: String
    var body: String?
    var state: String?
    var url: String?
    var labels: [String]?
    var author: String?
    var assignee: String?
    var source: String?
    var hasOptioLabel: Bool?
    var repo: Repo?
    var optioTask: OptioTaskRef?
    var createdAt: String?
    var updatedAt: String?

    var numberText: String {
        if let n = number?.intValue { return "#\(n)" }
        if let d = number?.doubleValue { return "#\(Int(d))" }
        if let s = number?.stringValue { return s }
        return ""
    }
    var numberInt: Int? { number?.intValue ?? number?.doubleValue.map { Int($0) } }
    var isAssignable: Bool {
        (source == nil || source == "github" || source == "gitlab") && repo?.id != nil && optioTask == nil
    }
    var identity: String { "\(repo?.fullName ?? source ?? "")-\(numberText)-\(id?.stringValue ?? id?.doubleValue.map { String($0) } ?? "")" }
}

enum RunFormatting {
    static func repoShortName(_ url: String) -> String {
        var s = url
        if let r = s.range(of: "://") { s = String(s[r.upperBound...]) }
        if let slash = s.firstIndex(of: "/") { s = String(s[s.index(after: slash)...]) }
        if s.hasSuffix(".git") { s.removeLast(4) }
        return s
    }

    static let agentTypes: [(String, String)] = [
        ("claude-code", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("copilot", "GitHub Copilot"),
        ("opencode", "OpenCode"),
        ("gemini", "Google Gemini"),
        ("openclaw", "OpenClaw"),
        ("cursor", "Cursor"),
    ]

    static func agentLabel(_ type: String?) -> String {
        guard let type else { return "default agent" }
        return agentTypes.first { $0.0 == type }?.1 ?? type
    }

    static func duration(_ ms: Double) -> String {
        let s = Int(ms / 1000)
        if s >= 3600 { return "\(s / 3600)h \((s % 3600) / 60)m" }
        if s >= 60 { return "\(s / 60)m \(s % 60)s" }
        return "\(s)s"
    }

    /// Mirrors the web's task-list stage derivation (pipeline-timeline.tsx).
    static func stage(for t: TaskRow) -> String {
        switch t.state {
        case "completed", "cancelled": return "done"
        case "failed": return "failed"
        case "pending", "queued", "waiting_on_deps": return "queue"
        case "provisioning": return "setup"
        case "running": return "running"
        case "needs_attention": return "attention"
        case "pr_opened":
            if let r = t.prReviewStatus, !["none", "pending"].contains(r) { return "review" }
            if t.prChecksStatus == "passing" { return "review" }
            return "ci"
        default: return "queue"
        }
    }
}
