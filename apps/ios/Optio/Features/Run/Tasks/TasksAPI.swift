import Foundation

struct TaskSearchResponse: Decodable {
    var tasks: [TaskRow]
    var nextCursor: String?
    var hasMore: Bool?
}

struct TaskDetailResponse: Decodable {
    struct StallInfo: Decodable {
        var isStalled: Bool
        var silentForMs: Double
        var thresholdMs: Double?
        var lastLogSummary: String?
    }
    var task: TaskRow
    var pendingReason: String?
    var stallInfo: StallInfo?
}

struct CreateTaskBody: Encodable {
    var type = "repo-task"
    var title: String
    var prompt: String
    var repoUrl: String
    var repoBranch: String?
    var agentType: String
    var description: String?
    var priority: Int?
    var maxRetries: Int?
    var ticketSource: String?
    var ticketExternalId: String?
    var dependsOn: [String]?
}

extension APIClient {
    // MARK: Tasks

    func listTasks(state: String? = nil, limit: Int = 100) async throws -> [TaskRow] {
        struct R: Decodable { var tasks: [TaskRow] }
        return try await get("/api/tasks", query: ["state": state, "limit": String(limit)], as: R.self).tasks
    }

    func searchTasks(q: String? = nil, agentType: String? = nil, repoUrl: String? = nil, createdAfter: String? = nil, cursor: String? = nil, limit: Int = 200) async throws -> TaskSearchResponse {
        try await get("/api/tasks/search", query: [
            "q": q?.isEmpty == true ? nil : q,
            "agentType": agentType,
            "repoUrl": repoUrl,
            "createdAfter": createdAfter,
            "cursor": cursor,
            "limit": String(limit),
        ], as: TaskSearchResponse.self)
    }

    func runTaskStats() async throws -> RunTaskStats {
        struct R: Decodable { var stats: RunTaskStats }
        return try await get("/api/tasks/stats", as: R.self).stats
    }

    func getTask(_ id: String) async throws -> TaskDetailResponse {
        try await get("/api/tasks/\(id)", as: TaskDetailResponse.self)
    }

    func createTask(_ body: CreateTaskBody) async throws -> TaskRow {
        struct R: Decodable { var task: TaskRow }
        return try await post("/api/tasks", body: body, as: R.self).task
    }

    func cancelTask(_ id: String) async throws { try await post("/api/tasks/\(id)/cancel") }
    func retryTask(_ id: String) async throws { try await post("/api/tasks/\(id)/retry") }
    func forceRedoTask(_ id: String) async throws { try await post("/api/tasks/\(id)/force-redo") }
    func runNowTask(_ id: String) async throws { try await post("/api/tasks/\(id)/run-now") }
    func launchReview(_ id: String) async throws { try await post("/api/tasks/\(id)/review") }

    func resumeTask(_ id: String, prompt: String?) async throws {
        struct B: Encodable { var prompt: String? }
        try await post("/api/tasks/\(id)/resume", body: B(prompt: prompt))
    }

    func forceRestartTask(_ id: String, prompt: String? = nil) async throws {
        struct B: Encodable { var prompt: String? }
        try await post("/api/tasks/\(id)/force-restart", body: B(prompt: prompt))
    }

    func sendTaskMessage(_ id: String, content: String, mode: String) async throws {
        struct B: Encodable { var content: String; var mode: String }
        try await post("/api/tasks/\(id)/message", body: B(content: content, mode: mode))
    }

    func taskLogs(_ id: String, limit: Int = 2000) async throws -> [TaskLogRow] {
        struct R: Decodable { var logs: [TaskLogRow] }
        return try await get("/api/tasks/\(id)/logs", query: ["limit": String(limit)], as: R.self).logs
    }

    func taskEvents(_ id: String) async throws -> [TaskEvent] {
        struct R: Decodable { var events: [TaskEvent] }
        return try await get("/api/tasks/\(id)/events", as: R.self).events
    }

    func taskActivity(_ id: String) async throws -> [TaskActivityItem] {
        struct R: Decodable { var activity: [TaskActivityItem] }
        return try await get("/api/tasks/\(id)/activity", as: R.self).activity
    }

    func taskComments(_ id: String) async throws -> [TaskComment] {
        struct R: Decodable { var comments: [TaskComment] }
        return try await get("/api/tasks/\(id)/comments", as: R.self).comments
    }

    func addTaskComment(_ id: String, content: String) async throws {
        struct B: Encodable { var content: String }
        try await post("/api/tasks/\(id)/comments", body: B(content: content))
    }

    func deleteTaskComment(_ id: String, commentId: String) async throws {
        try await delete("/api/tasks/\(id)/comments/\(commentId)")
    }

    func subtasks(_ id: String) async throws -> [TaskRow] {
        struct R: Decodable { var subtasks: [TaskRow] }
        return try await get("/api/tasks/\(id)/subtasks", as: R.self).subtasks
    }

    func createSubtask(_ id: String, title: String, prompt: String, taskType: String, blocksParent: Bool) async throws {
        struct B: Encodable { var title: String; var prompt: String; var taskType: String; var blocksParent: Bool }
        try await post("/api/tasks/\(id)/subtasks", body: B(title: title, prompt: prompt, taskType: taskType, blocksParent: blocksParent))
    }

    func taskDependencies(_ id: String) async throws -> [TaskRow] {
        struct R: Decodable { var dependencies: [TaskRow] }
        return try await get("/api/tasks/\(id)/dependencies", as: R.self).dependencies
    }

    func taskDependents(_ id: String) async throws -> [TaskRow] {
        struct R: Decodable { var dependents: [TaskRow] }
        return try await get("/api/tasks/\(id)/dependents", as: R.self).dependents
    }

    func addTaskDependencies(_ id: String, dependsOnIds: [String]) async throws {
        struct B: Encodable { var dependsOnIds: [String] }
        try await post("/api/tasks/\(id)/dependencies", body: B(dependsOnIds: dependsOnIds))
    }

    func removeTaskDependency(_ id: String, depId: String) async throws {
        try await delete("/api/tasks/\(id)/dependencies/\(depId)")
    }

    // MARK: Supporting catalogs

    func runListRepos() async throws -> [RunRepoRow] {
        struct R: Decodable { var repos: [RunRepoRow] }
        return try await get("/api/repos", as: R.self).repos
    }

    func runListPromptTemplates(kind: String) async throws -> [RunPromptTemplateRow] {
        struct R: Decodable { var templates: [RunPromptTemplateRow] }
        return try await get("/api/prompt-templates", query: ["kind": kind], as: R.self).templates
    }
}
