import Foundation

// MARK: - Claude usage / auth status (`GET /api/auth/usage`, `GET /api/auth/status`)

struct UsageWindow: Decodable, Hashable, Sendable {
    var utilization: Double?
    var resetsAt: String?
}

/// A per-model 7-day cap (Fable, …): a model can be locked while the
/// account-wide 7-day still looks fine.
struct UsageModelWindow: Decodable, Hashable, Sendable {
    var model: String
    var utilization: Double?
    var resetsAt: String?
    var severity: String?
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

/// The `usage` envelope of `/api/auth/usage` (`api-client.ts` `getUsage`).
struct ClaudeUsageData: Decodable, Hashable, Sendable {
    var available: Bool = false
    var error: String?
    var hasRecentAuthFailure: Bool?
    var authFailures: AuthFailures?
    var fiveHour: UsageWindow?
    var sevenDay: UsageWindow?
    var sevenDaySonnet: UsageWindow?
    var sevenDayOpus: UsageWindow?
    var sevenDayModels: [UsageModelWindow]?
    var extraUsage: ExtraUsage?
    /// When Anthropic answered. With `stale`, the age of the last good numbers.
    var asOf: String?
    /// Last good numbers, served because the latest upstream read failed.
    var stale: Bool?

    private enum CodingKeys: String, CodingKey {
        case available, error, hasRecentAuthFailure, authFailures, fiveHour, sevenDay, sevenDaySonnet, sevenDayOpus,
             sevenDayModels, extraUsage, asOf, stale
    }

    init(available: Bool, error: String? = nil, fiveHour: UsageWindow? = nil, sevenDay: UsageWindow? = nil,
         sevenDayModels: [UsageModelWindow]? = nil) {
        self.available = available
        self.error = error
        self.fiveHour = fiveHour
        self.sevenDay = sevenDay
        self.sevenDayModels = sevenDayModels
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
        sevenDayModels = try c.decodeIfPresent([UsageModelWindow].self, forKey: .sevenDayModels)
        extraUsage = try c.decodeIfPresent(ExtraUsage.self, forKey: .extraUsage)
        asOf = try c.decodeIfPresent(String.self, forKey: .asOf)
        stale = try c.decodeIfPresent(Bool.self, forKey: .stale)
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

// MARK: - Endpoints

extension APIClient {
    /// `fresh` bypasses the server's cache and re-reads from Anthropic.
    func accountUsage(fresh: Bool = false) async throws -> ClaudeUsageData {
        struct R: Decodable { var usage: ClaudeUsageData }
        return try await get("/api/auth/usage", query: ["fresh": fresh ? "1" : nil], as: R.self).usage
    }

    func dashAuthStatus() async throws -> DashAuthStatus {
        try await get("/api/auth/status")
    }
}
