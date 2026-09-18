import Foundation

struct TaskConfigBody: Encodable {
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
    var enabled: Bool?
}

struct TaskConfigEnvelope: Decodable { var taskConfig: TaskConfigRow }

struct TriggerBody: Encodable {
    var type: String
    var config: [String: AnyCodable]
    var enabled: Bool = true
}

extension APIClient {
    func listTaskConfigs() async throws -> [TaskConfigRow] {
        struct R: Decodable { var taskConfigs: [TaskConfigRow] }
        return try await get("/api/task-configs", as: R.self).taskConfigs
    }

    func getTaskConfig(_ id: String) async throws -> TaskConfigRow {
        struct R: Decodable { var taskConfig: TaskConfigRow }
        return try await get("/api/task-configs/\(id)", as: R.self).taskConfig
    }

    func createTaskConfig(_ body: TaskConfigBody) async throws -> TaskConfigRow {
        struct R: Decodable { var taskConfig: TaskConfigRow }
        return try await post("/api/task-configs", body: body, as: R.self).taskConfig
    }

    func updateTaskConfig(_ id: String, _ body: some Encodable) async throws -> TaskConfigRow {
        try await patch("/api/task-configs/\(id)", body: body, as: TaskConfigEnvelope.self).taskConfig
    }

    func setTaskConfigEnabled(_ id: String, _ enabled: Bool) async throws {
        struct B: Encodable { var enabled: Bool }
        _ = try await updateTaskConfig(id, B(enabled: enabled))
    }

    func deleteTaskConfig(_ id: String) async throws { try await delete("/api/task-configs/\(id)") }

    /// `POST /api/task-configs/:id/run` → 202 `{ taskId }`.
    func runTaskConfig(_ id: String) async throws -> String {
        struct R: Decodable { var taskId: String }
        return try await post("/api/task-configs/\(id)/run", as: R.self).taskId
    }

    func taskConfigTriggers(_ id: String) async throws -> [TriggerRow] {
        struct R: Decodable { var triggers: [TriggerRow] }
        return try await get("/api/task-configs/\(id)/triggers", as: R.self).triggers
    }

    func createTaskConfigTrigger(_ id: String, _ body: TriggerBody) async throws {
        try await post("/api/task-configs/\(id)/triggers", body: body)
    }

    func setTaskConfigTriggerEnabled(_ id: String, triggerId: String, _ enabled: Bool) async throws {
        struct B: Encodable { var enabled: Bool }
        _ = try await patch("/api/task-configs/\(id)/triggers/\(triggerId)", body: B(enabled: enabled), as: APIClient.Empty.self)
    }

    func deleteTaskConfigTrigger(_ id: String, triggerId: String) async throws {
        try await delete("/api/task-configs/\(id)/triggers/\(triggerId)")
    }

    /// Unified runs route: for a blueprint the rows are the spawned `tasks`.
    func taskConfigRuns(_ id: String) async throws -> [TaskRow] {
        struct R: Decodable { var runs: [TaskRow] }
        return try await get("/api/tasks/\(id)/runs", as: R.self).runs
    }
}
