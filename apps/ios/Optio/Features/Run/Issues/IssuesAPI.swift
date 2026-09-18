import Foundation

extension APIClient {
    func listIssues(repoId: String? = nil, state: String? = nil) async throws -> [IssueRow] {
        struct R: Decodable { var issues: [IssueRow] }
        return try await get("/api/issues", query: ["repoId": repoId, "state": state], as: R.self).issues
    }

    /// `POST /api/issues/assign` — creates a Repo Task tied to the issue
    /// (ticketSource/ticketExternalId) and adds the `optio` label, like the web.
    func assignIssue(number: Int, repoId: String, title: String, body: String, agentType: String?) async throws -> TaskRow {
        struct B: Encodable { var issueNumber: Int; var repoId: String; var title: String; var body: String; var agentType: String? }
        struct R: Decodable { var task: TaskRow }
        return try await post("/api/issues/assign", body: B(issueNumber: number, repoId: repoId, title: title, body: body, agentType: agentType), as: R.self).task
    }
}
