import Foundation

// MARK: - Envelopes and local row types (routes/persistent-agents.ts)

struct PersistentAgentStats: Decodable, Hashable, Sendable {
    var total = 0
    var idle = 0
    var queued = 0
    var running = 0
    var paused = 0
    var failed = 0
    var archived = 0
}

struct PersistentAgentInbox: Decodable, Hashable, Sendable {
    var pending: Int = 0
    var oldest: Date?
}

/// A `persistent_agent_turn_logs` row as returned by `GET .../turns/:turnId`.
struct PersistentAgentTurnLog: Decodable, Hashable, Sendable {
    var id: String?
    var turnId: String?
    var stream: String?
    var content: String
    var logType: String?
    var metadata: [String: AnyCodable]?
    var timestamp: Date?

    func asLogEntry(agentId: String) -> AgentLogEntry {
        AgentLogEntry(
            taskId: agentId,
            timestamp: timestamp.map { ISO8601DateFormatter().string(from: $0) } ?? "",
            type: AgentLogEntry.TypeValue(rawValue: logType ?? "text") ?? .text,
            content: content,
            metadata: metadata
        )
    }
}

/// `workflow_triggers` rows targeting a persistent agent. The generated
/// `WorkflowTrigger` requires a non-null `workflowId`, which these rows lack.
struct PersistentAgentTrigger: Decodable, Hashable, Identifiable, Sendable {
    var id: String
    var type: String
    var config: [String: AnyCodable]?
    var enabled: Bool?
    var lastFiredAt: Date?
    var nextFireAt: Date?
    var createdAt: Date?

    var summary: String {
        switch type {
        case "schedule": return config?["cronExpression"]?.stringValue ?? "cron"
        case "webhook": return config?["path"]?.stringValue.map { "/api/webhooks/\($0)" } ?? "webhook"
        case "ticket": return config?["providerId"]?.stringValue ?? "ticket"
        default: return "manual"
        }
    }
}

/// Body for `POST /api/persistent-agents` and `PATCH /api/persistent-agents/:id`.
/// Nil fields are omitted so PATCH only touches what was edited.
struct PersistentAgentInput: Encodable {
    var slug: String?
    var name: String?
    var description: String?
    var agentRuntime: String?
    var model: String?
    var systemPrompt: String?
    var agentsMd: String?
    var initialPrompt: String?
    var podLifecycle: String?
    var idlePodTimeoutMs: Int?
    var maxTurnDurationMs: Int?
    var maxTurns: Int?
    var consecutiveFailureLimit: Int?
    var enabled: Bool?
}

struct PersistentAgentTriggerInput: Encodable {
    var type: String
    var config: [String: String]
    var enabled: Bool = true
}

extension APIClient {
    func listPersistentAgents() async throws -> [PersistentAgent] {
        struct R: Decodable { var agents: [PersistentAgent] }
        return try await get("/api/persistent-agents", as: R.self).agents
    }

    func livePersistentAgentStats() async throws -> PersistentAgentStats {
        struct R: Decodable { var stats: PersistentAgentStats }
        return try await get("/api/persistent-agents/stats", as: R.self).stats
    }

    func getPersistentAgent(_ id: String) async throws -> (agent: PersistentAgent, inbox: PersistentAgentInbox) {
        struct R: Decodable { var agent: PersistentAgent; var inbox: PersistentAgentInbox? }
        let r = try await get("/api/persistent-agents/\(id)", as: R.self)
        return (r.agent, r.inbox ?? PersistentAgentInbox())
    }

    func createPersistentAgent(_ input: PersistentAgentInput) async throws -> PersistentAgent {
        struct R: Decodable { var agent: PersistentAgent }
        return try await post("/api/persistent-agents", body: input, as: R.self).agent
    }

    func updatePersistentAgent(_ id: String, _ input: PersistentAgentInput) async throws -> PersistentAgent {
        struct R: Decodable { var agent: PersistentAgent }
        return try await patch("/api/persistent-agents/\(id)", body: input, as: R.self).agent
    }

    func deletePersistentAgent(_ id: String) async throws {
        try await delete("/api/persistent-agents/\(id)")
    }

    func sendPersistentAgentMessage(_ id: String, body: String) async throws {
        struct B: Encodable { var body: String }
        try await post("/api/persistent-agents/\(id)/messages", body: B(body: body))
    }

    func listPersistentAgentMessages(_ id: String, limit: Int = 100) async throws -> [PersistentAgentMessage] {
        struct R: Decodable { var messages: [PersistentAgentMessage] }
        return try await get("/api/persistent-agents/\(id)/messages", query: ["limit": String(limit)], as: R.self).messages
    }

    func listPersistentAgentTurns(_ id: String, limit: Int = 50) async throws -> [PersistentAgentTurn] {
        struct R: Decodable { var turns: [PersistentAgentTurn] }
        return try await get("/api/persistent-agents/\(id)/turns", query: ["limit": String(limit)], as: R.self).turns
    }

    func getPersistentAgentTurn(_ id: String, turnId: String) async throws -> (turn: PersistentAgentTurn, logs: [PersistentAgentTurnLog]) {
        struct R: Decodable { var turn: PersistentAgentTurn; var logs: [PersistentAgentTurnLog]? }
        let r = try await get("/api/persistent-agents/\(id)/turns/\(turnId)", as: R.self)
        return (r.turn, r.logs ?? [])
    }

    func controlPersistentAgent(_ id: String, intent: PersistentAgentControlIntent) async throws {
        struct B: Encodable { var intent: String }
        try await post("/api/persistent-agents/\(id)/control", body: B(intent: intent.rawValue))
    }

    func listPersistentAgentTriggers(_ id: String) async throws -> [PersistentAgentTrigger] {
        struct R: Decodable { var triggers: [PersistentAgentTrigger] }
        return try await get("/api/persistent-agents/\(id)/triggers", as: R.self).triggers
    }

    func createPersistentAgentTrigger(_ id: String, _ input: PersistentAgentTriggerInput) async throws -> PersistentAgentTrigger {
        struct R: Decodable { var trigger: PersistentAgentTrigger }
        return try await post("/api/persistent-agents/\(id)/triggers", body: input, as: R.self).trigger
    }

    func deletePersistentAgentTrigger(_ id: String, triggerId: String) async throws {
        try await delete("/api/persistent-agents/\(id)/triggers/\(triggerId)")
    }
}
