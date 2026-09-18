import Foundation

// MARK: - Envelopes and local row types (routes/sessions.ts)

struct SessionStats: Decodable, Hashable, Sendable {
    var total = 0
    var active = 0
    var ended = 0
}

struct SessionModelConfig: Decodable, Hashable, Sendable {
    var claudeModel: String?
    var availableModels: [String]?
}

/// Persisted chat event (`GET /api/sessions/:id/chat`).
struct SessionChatHistoryEvent: Decodable, Hashable, Sendable {
    var id: String?
    var stream: String?
    var content: String
    var logType: String?
    var metadata: [String: AnyCodable]?
    var timestamp: Date?
}

/// Minimal repo row for the session repo picker (`GET /api/repos`).
struct SessionRepoOption: Decodable, Hashable, Identifiable, Sendable {
    var id: String
    var repoUrl: String
    var fullName: String?
    var displayName: String { fullName ?? repoUrl.replacingOccurrences(of: "https://github.com/", with: "") }
}

extension APIClient {
    func listSessions(state: String? = nil, repoUrl: String? = nil, limit: Int = 100) async throws -> (sessions: [InteractiveSession], activeCount: Int) {
        struct R: Decodable { var sessions: [InteractiveSession]; var activeCount: Int? }
        let r = try await get("/api/sessions", query: ["state": state, "repoUrl": repoUrl, "limit": String(limit)], as: R.self)
        return (r.sessions, r.activeCount ?? 0)
    }

    func liveSessionStats() async throws -> SessionStats {
        struct R: Decodable { var stats: SessionStats }
        return try await get("/api/sessions/stats", as: R.self).stats
    }

    func getSession(_ id: String) async throws -> (session: InteractiveSession, modelConfig: SessionModelConfig?) {
        struct R: Decodable { var session: InteractiveSession; var modelConfig: SessionModelConfig? }
        let r = try await get("/api/sessions/\(id)", as: R.self)
        return (r.session, r.modelConfig)
    }

    func createSession(repoUrl: String) async throws -> InteractiveSession {
        struct B: Encodable { var repoUrl: String }
        struct R: Decodable { var session: InteractiveSession }
        return try await post("/api/sessions", body: B(repoUrl: repoUrl), as: R.self).session
    }

    func endSession(_ id: String) async throws -> InteractiveSession {
        struct R: Decodable { var session: InteractiveSession }
        return try await post("/api/sessions/\(id)/end", as: R.self).session
    }

    func sessionChatHistory(_ id: String, limit: Int = 1000) async throws -> [SessionChatHistoryEvent] {
        struct R: Decodable { var events: [SessionChatHistoryEvent] }
        return try await get("/api/sessions/\(id)/chat", query: ["limit": String(limit)], as: R.self).events
    }

    func listSessionPrs(_ id: String) async throws -> [SessionPr] {
        struct R: Decodable { var prs: [SessionPr] }
        return try await get("/api/sessions/\(id)/prs", as: R.self).prs
    }

    func listSessionRepos() async throws -> [SessionRepoOption] {
        struct R: Decodable { var repos: [SessionRepoOption] }
        return try await get("/api/repos", as: R.self).repos
    }
}
