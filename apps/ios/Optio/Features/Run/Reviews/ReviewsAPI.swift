import Foundation
import SwiftUI

// MARK: - Row types
//
// `/api/pull-requests` returns git-platform PR summaries enriched with the
// matching `pr_reviews` row (id/state/verdict/origin), and `/api/pr-reviews/:id`
// returns the full review. Both are route-level shapes, so they live here.

struct PullRequestSummary: Decodable, Identifiable, Hashable {
    struct Repo: Decodable, Hashable {
        let id: String?
        let fullName: String?
        let repoUrl: String?
    }
    struct EmbeddedReview: Decodable, Hashable {
        let id: String
        let state: String?
        let verdict: String?
        let origin: String?
        let updatedAt: Date?
    }

    let number: Int
    let title: String
    let url: String
    let state: String?
    let draft: Bool?
    let author: String?
    let labels: [String]?
    let headSha: String?
    let repo: Repo?
    let updatedAt: Date?
    let review: EmbeddedReview?

    var id: String { "\(repo?.fullName ?? "")#\(number)" }
}

struct PrReview: Decodable, Hashable {
    let id: String
    let prUrl: String
    let prNumber: Int?
    let repoOwner: String?
    let repoName: String?
    let repoUrl: String?
    let headSha: String?
    let state: String
    let verdict: String?
    let summary: String?
    let fileComments: [PrReviewFileComment]?
    let origin: String?
    let userEngaged: Bool?
    let autoSubmitted: Bool?
    let submittedAt: Date?
    let errorMessage: String?
    let controlIntent: String?
    let createdAt: Date?
    let updatedAt: Date?

    var repoFullName: String { [repoOwner, repoName].compactMap { $0 }.joined(separator: "/") }
    var isEditable: Bool { ["ready", "stale"].contains(state) }
    var isWorking: Bool { ["queued", "waiting_ci", "reviewing"].contains(state) }
    var hasDraft: Bool { ["ready", "stale", "submitted"].contains(state) }
    var canReReview: Bool { ["ready", "stale", "submitted", "failed"].contains(state) }
    var canCancel: Bool { !["cancelled", "submitted"].contains(state) }
    var platformName: String { prUrl.contains("gitlab") ? "GitLab" : prUrl.contains("codecommit") ? "CodeCommit" : "GitHub" }
}

struct PrReviewRun: Decodable, Identifiable, Hashable {
    let id: String
    let kind: String?
    let state: String
    let resultSummary: String?
    let errorMessage: String?
    let costUsd: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let modelUsed: String?
    let startedAt: Date?
    let completedAt: Date?
    let createdAt: Date?

    var durationText: String? {
        guard let startedAt else { return nil }
        return JobRun.formatDuration((completedAt ?? Date()).timeIntervalSince(startedAt))
    }
}

struct ReviewChatMessage: Decodable, Identifiable, Hashable {
    let id: String
    let runId: String?
    let role: String
    let content: String
    let createdAt: Date?
}

struct PrStatus: Decodable {
    let checksStatus: String?
    let reviewStatus: String?
    let mergeable: Bool?
    let prState: String?
    let headSha: String?

    var isOpen: Bool { prState == "open" }
    var checksOk: Bool { checksStatus == "passing" || checksStatus == "none" }
}

struct RepoSummary: Decodable, Identifiable, Hashable {
    let id: String
    let fullName: String?
}

enum ReviewFormat {
    static func stateLabel(_ state: String) -> String {
        switch state {
        case "waiting_ci": return "Waiting for CI"
        case "reviewing": return "Reviewing…"
        case "ready": return "Draft Ready"
        default: return state.replacingOccurrences(of: "_", with: " ").capitalized
        }
    }

    /// Review state → tone. `ready` (a draft waiting for you) is the only accent.
    static func stateTone(_ state: String) -> Tone {
        switch state {
        case "queued", "waiting_ci": return .idle
        case "reviewing": return .working
        case "ready": return .accent
        case "stale": return .idle
        case "failed": return .danger
        case "submitted": return .success
        case "cancelled": return .idle
        default: return Tone.forState(state)
        }
    }

    static func verdictLabel(_ verdict: String) -> String {
        switch verdict {
        case "approve": return "Approve"
        case "request_changes": return "Request Changes"
        case "comment": return "Comment"
        default: return verdict
        }
    }

    static func verdictTone(_ verdict: String) -> Tone {
        switch verdict {
        case "approve": return .success
        case "request_changes": return .danger
        default: return .working
        }
    }

    static func verdictIcon(_ verdict: String) -> String {
        switch verdict {
        case "approve": return "hand.thumbsup"
        case "request_changes": return "hand.thumbsdown"
        default: return "text.bubble"
        }
    }

    static let mergeMethods: [(String, String)] = [
        ("squash", "Squash and merge"),
        ("merge", "Create a merge commit"),
        ("rebase", "Rebase and merge"),
    ]
}


// MARK: - Endpoints

extension APIClient {
    struct PullRequestListResponse: Decodable { let pullRequests: [PullRequestSummary] }
    struct PrReviewResponse: Decodable { let review: PrReview }
    struct PrReviewRunsResponse: Decodable { let runs: [PrReviewRun] }
    struct PrReviewLogsResponse: Decodable { let logs: [RunLogRow]; let runId: String? }
    struct ReviewChatResponse: Decodable { let messages: [ReviewChatMessage] }
    struct RepoListResponse: Decodable { let repos: [RepoSummary] }

    func listOpenPullRequests(repoId: String? = nil) async throws -> [PullRequestSummary] {
        try await get("/api/pull-requests", query: ["repoId": repoId], as: PullRequestListResponse.self).pullRequests
    }

    func listReposForReviews() async throws -> [RepoSummary] {
        try await get("/api/repos", as: RepoListResponse.self).repos
    }

    func createPrReview(prUrl: String) async throws -> PrReview {
        struct Body: Encodable { let prUrl: String }
        return try await post("/api/pr-reviews", body: Body(prUrl: prUrl), as: PrReviewResponse.self).review
    }

    func getPrReview(_ id: String) async throws -> PrReview {
        try await get("/api/pr-reviews/\(id)", as: PrReviewResponse.self).review
    }

    func listPrReviewRuns(_ id: String) async throws -> [PrReviewRun] {
        try await get("/api/pr-reviews/\(id)/runs", as: PrReviewRunsResponse.self).runs
    }

    struct PrReviewDraftPatch: Encodable {
        var summary: String?
        var verdict: String?
        var fileComments: [PrReviewFileComment]?
    }

    func updatePrReview(_ id: String, _ patch: PrReviewDraftPatch) async throws -> PrReview {
        try await self.patch("/api/pr-reviews/\(id)", body: patch, as: PrReviewResponse.self).review
    }

    func submitPrReview(_ id: String) async throws -> PrReview {
        try await post("/api/pr-reviews/\(id)/submit", as: PrReviewResponse.self).review
    }

    func reReviewPr(_ id: String) async throws {
        try await post("/api/pr-reviews/\(id)/re-review")
    }

    func cancelPrReview(_ id: String) async throws {
        try await post("/api/pr-reviews/\(id)/cancel")
    }

    func prReviewLogs(_ id: String, runId: String? = nil) async throws -> [RunLogRow] {
        try await get("/api/pr-reviews/\(id)/logs", query: ["runId": runId], as: PrReviewLogsResponse.self).logs
    }

    func listPrReviewChat(_ id: String) async throws -> [ReviewChatMessage] {
        try await get("/api/pr-reviews/\(id)/chat", as: ReviewChatResponse.self).messages
    }

    func postPrReviewChat(_ id: String, message: String) async throws {
        struct Body: Encodable { let message: String }
        try await post("/api/pr-reviews/\(id)/chat", body: Body(message: message))
    }

    func prStatus(prUrl: String) async throws -> PrStatus {
        try await get("/api/pull-requests/status", query: ["prUrl": prUrl], as: PrStatus.self)
    }

    func mergePullRequest(prUrl: String, method: String) async throws {
        struct Body: Encodable { let prUrl: String; let mergeMethod: String }
        try await post("/api/pull-requests/merge", body: Body(prUrl: prUrl, mergeMethod: method))
    }
}
