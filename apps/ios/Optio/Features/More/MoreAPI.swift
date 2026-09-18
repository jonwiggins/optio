import Foundation

// Row types for routes whose responses are enriched or loosely typed on the
// server (`z.unknown()` schemas). Every field is optional so a server that adds
// or drops a column never breaks decoding.

// MARK: - Prompts

struct PromptTemplateRow: Decodable, Identifiable, Hashable {
    var id: String
    var name: String
    var template: String?
    var kind: String?
    var description: String?
    var paramsSchema: [String: AnyCodable]?
    var defaultAgentType: String?
    var isDefault: Bool?
    var repoUrl: String?
    var workspaceId: String?
    var createdAt: String?
    var updatedAt: String?

    /// Parameter names declared in `paramsSchema.properties`, or extracted from `{{param}}` tokens.
    var paramNames: [String] {
        if let props = paramsSchema?["properties"]?.objectValue, !props.isEmpty {
            return props.keys.sorted()
        }
        guard let body = template else { return [] }
        var names = Set<String>()
        var scanner = body[...]
        while let open = scanner.range(of: "{{") {
            scanner = scanner[open.upperBound...]
            guard let close = scanner.range(of: "}}") else { break }
            var token = scanner[..<close.lowerBound].trimmingCharacters(in: .whitespaces)
            scanner = scanner[close.upperBound...]
            if token.hasPrefix("#if ") { token = String(token.dropFirst(4)) }
            if token.hasPrefix("/") || token.hasPrefix("#") || token.isEmpty { continue }
            names.insert(token)
        }
        return names.sorted()
    }
}

struct PromptTemplateInput: Encodable {
    var name: String
    var template: String
    var kind: String
    var description: String?
    var defaultAgentType: String?
}

// MARK: - Repos

struct RepoRow: Decodable, Identifiable, Hashable {
    var id: String
    var repoUrl: String?
    var gitPlatform: String?
    var fullName: String?
    var defaultBranch: String?
    var isPrivate: Bool?
    var imagePreset: String?
    var extraPackages: String?
    var setupCommands: String?
    var customDockerfile: String?
    var autoMerge: Bool?
    var cautiousMode: Bool?
    var defaultAgentType: String?
    var promptTemplateOverride: String?
    var claudeModel: String?
    var claudeContextWindow: String?
    var claudeThinking: Bool?
    var claudeEffort: String?
    var maxTurnsCoding: Int?
    var maxTurnsReview: Int?
    var autoResume: Bool?
    var planningModeEnabled: Bool?
    var maxConcurrentTasks: Int?
    var maxPodInstances: Int?
    var maxAgentsPerPod: Int?
    var reviewEnabled: Bool?
    var reviewTrigger: String?
    var testCommand: String?
    var reviewAgentType: String?
    var reviewModel: String?
    var effectiveReviewAgentType: String?
    var effectiveReviewModel: String?
    var externalReviewMode: String?
    var externalReviewWaitForCi: Bool?
    var maxAutoResumes: Int?
    var networkPolicy: String?
    var secretProxy: Bool?
    var offPeakOnly: Bool?
    var cpuRequest: String?
    var cpuLimit: String?
    var memoryRequest: String?
    var memoryLimit: String?
    var dockerInDocker: Bool?
    var createdAt: String?
    var updatedAt: String?

    var displayName: String { fullName ?? repoUrl ?? id }
}

/// PATCH body for `/api/repos/:id`. Only the fields the iOS form edits.
struct RepoUpdateInput: Encodable {
    var defaultBranch: String?
    var defaultAgentType: String?
    var imagePreset: String?
    var extraPackages: String?
    var setupCommands: String?
    var claudeModel: String?
    var claudeContextWindow: String?
    var claudeThinking: Bool?
    var claudeEffort: String?
    var maxTurnsCoding: Int?
    var maxTurnsReview: Int?
    var maxConcurrentTasks: Int?
    var maxPodInstances: Int?
    var maxAgentsPerPod: Int?
    var cautiousMode: Bool?
    var planningModeEnabled: Bool?
    var reviewEnabled: Bool?
    var reviewTrigger: String?
    var testCommand: String?
    var reviewAgentType: AnyCodable?
    var reviewModel: String?
    var autoResume: Bool?
    var autoMerge: Bool?
    var externalReviewMode: String?
    var externalReviewWaitForCi: Bool?
    var networkPolicy: String?
    var secretProxy: Bool?
    var offPeakOnly: Bool?
    var dockerInDocker: Bool?
}

struct RepoCreateInput: Encodable {
    var repoUrl: String
    var fullName: String
    var defaultBranch: String?
    var isPrivate: Bool?
}

struct RepoValidation: Decodable {
    struct Info: Decodable {
        var fullName: String?
        var defaultBranch: String?
        var isPrivate: Bool?
    }
    var valid: Bool
    var error: String?
    var repo: Info?
}

struct SharedDirectoryRow: Decodable, Identifiable, Hashable {
    var id: String
    var repoId: String?
    var name: String?
    var description: String?
    var mountLocation: String?
    var mountSubPath: String?
    var sizeGi: Int?
    var scope: String?
    var lastClearedAt: String?
    var lastMountedAt: String?
    var createdAt: String?
}

struct SharedDirectoryInput: Encodable {
    var name: String
    var description: String?
    var mountLocation: String
    var mountSubPath: String
    var sizeGi: Int?
}

struct McpServerRow: Decodable, Identifiable, Hashable {
    var id: String
    var name: String?
    var command: String?
    var args: [String]?
    var installCommand: String?
    var scope: String?
    var repoUrl: String?
    var enabled: Bool?
    var createdAt: String?
}

struct McpServerInput: Encodable {
    var name: String
    var command: String
    var args: [String]?
    var env: [String: String]?
    var installCommand: String?
    var repoUrl: String?
}

// MARK: - Connections

struct ConnectionProviderRow: Decodable, Identifiable, Hashable {
    var id: String
    var slug: String?
    var name: String?
    var description: String?
    var icon: String?
    var category: String?
    var type: String?
    var configSchema: [String: AnyCodable]?
    var requiredSecrets: [String]?
    var capabilities: [String]?
    var docsUrl: String?
    var builtIn: Bool?

    struct ConfigField: Identifiable, Hashable {
        var key: String
        var title: String
        var placeholder: String?
        var isSecret: Bool
        var required: Bool
        var id: String { key }
    }

    /// Fields from the provider's JSON-Schema `configSchema`, in stable key order.
    var configFields: [ConfigField] {
        guard let props = configSchema?["properties"]?.objectValue else { return [] }
        let required = Set(configSchema?["required"]?.arrayValue?.compactMap(\.stringValue) ?? [])
        return props.keys.sorted().map { key in
            let schema = props[key]?.objectValue ?? [:]
            return ConfigField(
                key: key,
                title: schema["title"]?.stringValue ?? key,
                placeholder: schema["placeholder"]?.stringValue,
                isSecret: schema["format"]?.stringValue == "secret",
                required: required.contains(key)
            )
        }
    }
}

struct ConnectionRow: Decodable, Identifiable, Hashable {
    var id: String
    var name: String?
    var providerId: String?
    var scope: String?
    var repoUrl: String?
    var enabled: Bool?
    var status: String?
    var statusMessage: String?
    var lastCheckedAt: String?
    var createdAt: String?
    var provider: ConnectionProviderRow?
    var assignments: [ConnectionAssignmentRow]?
    // `config` is deliberately not decoded: it may hold secret values.
}

struct ConnectionAssignmentRow: Decodable, Identifiable, Hashable {
    var id: String
    var connectionId: String?
    var repoId: String?
    var agentTypes: [String]?
    var permission: String?
    var enabled: Bool?
    var createdAt: String?
}

struct ConnectionCreateInput: Encodable {
    struct Assignment: Encodable {
        var repoId: String?
        var agentTypes: [String]
        var permission: String
    }
    var providerId: String
    var name: String
    var config: [String: String]
    var assignments: [Assignment]
}

struct ConnectionAssignmentInput: Encodable {
    var repoId: String?
    var agentTypes: [String]
    var permission: String
}

// MARK: - Secrets

struct SecretRow: Decodable, Identifiable, Hashable {
    var id: String?
    var name: String
    var scope: String?
    var userId: String?
    var createdAt: String?
    var updatedAt: String?

    // Secrets are unique per (name, scope); some rows may lack an id.
    var listId: String { id ?? "\(name)@\(scope ?? "global")" }
}

struct SecretCreateResult: Decodable {
    struct Validation: Decodable {
        var valid: Bool
        var error: String?
    }
    var name: String
    var scope: String?
    var validation: Validation?
}

// MARK: - Webhooks

struct WebhookRow: Decodable, Identifiable, Hashable {
    var id: String
    var url: String?
    var events: [String]?
    var description: String?
    var secret: String?
    var active: Bool?
    var createdAt: String?
    var updatedAt: String?
}

struct WebhookDeliveryRow: Decodable, Identifiable, Hashable {
    var id: String
    var webhookId: String?
    var event: String?
    var payload: AnyCodable?
    var statusCode: Int?
    var responseBody: String?
    var success: Bool?
    var attempt: Int?
    var error: String?
    var deliveredAt: String?
}

struct WebhookCreateInput: Encodable {
    var url: String
    var events: [String]
    var secret: String?
    var description: String?
}

struct WebhookUpdateInput: Encodable {
    var active: Bool?
}

// MARK: - Workspaces

struct WorkspaceRow: Decodable, Identifiable, Hashable {
    var id: String
    var name: String?
    var slug: String?
    var description: String?
    var role: String?
    var allowDockerInDocker: Bool?
    var createdAt: String?
}

struct WorkspaceMemberRow: Decodable, Identifiable, Hashable {
    var id: String
    var workspaceId: String?
    var userId: String
    var role: String?
    var email: String?
    var displayName: String?
    var avatarUrl: String?
    var createdAt: String?
}

struct LookupUser: Decodable {
    var id: String
    var email: String?
    var displayName: String?
}

// MARK: - Settings

struct OptioSettingsRow: Decodable {
    var model: String?
    var systemPrompt: String?
    var enabledTools: [String]?
    var confirmWrites: Bool?
    var maxTurns: Double?
    var defaultReviewAgentType: String?
    var defaultReviewModel: String?
}

struct ClaudeAuthStatus: Decodable {
    struct Subscription: Decodable {
        var available: Bool?
        var expiresAt: String?
        var error: String?
        var expired: Bool?
        var lastValidated: String?
    }
    var subscription: Subscription
}

struct AuthProviderInfo: Decodable {
    var name: String
    var displayName: String?
}

struct ApiKeyRow: Decodable, Identifiable, Hashable {
    var id: String
    var name: String?
    var prefix: String?
    var lastUsedAt: String?
    var expiresAt: String?
    var createdAt: String?
}

struct CreatedApiKey: Decodable {
    var token: String
    var tokenId: String?
    var prefix: String?
    var name: String?
}

struct NotificationPref: Codable, Hashable {
    var push: Bool
}

// MARK: - Endpoints

extension APIClient {
    private struct Envelope<T: Decodable>: Decodable { let value: T }

    // Prompts
    func listPromptTemplates(kind: String? = nil) async throws -> [PromptTemplateRow] {
        struct R: Decodable { var templates: [PromptTemplateRow] }
        return try await get("/api/prompt-templates", query: ["kind": kind], as: R.self).templates
    }

    func createPromptTemplate(_ input: PromptTemplateInput) async throws -> PromptTemplateRow {
        struct R: Decodable { var template: PromptTemplateRow }
        return try await post("/api/prompt-templates/named", body: input, as: R.self).template
    }

    func updatePromptTemplate(_ id: String, _ input: PromptTemplateInput) async throws -> PromptTemplateRow {
        struct R: Decodable { var template: PromptTemplateRow }
        return try await patch("/api/prompt-templates/\(id)", body: input, as: R.self).template
    }

    func deletePromptTemplate(_ id: String) async throws {
        try await delete("/api/prompt-templates/\(id)")
    }

    func previewPromptTemplate(_ id: String, params: [String: String]) async throws -> String {
        struct B: Encodable { var params: [String: String] }
        struct R: Decodable { var rendered: String }
        return try await post("/api/prompt-templates/\(id)/preview", body: B(params: params), as: R.self).rendered
    }

    // Repos
    func listRepos() async throws -> [RepoRow] {
        struct R: Decodable { var repos: [RepoRow] }
        return try await get("/api/repos", as: R.self).repos
    }

    func getRepo(_ id: String) async throws -> RepoRow {
        struct R: Decodable { var repo: RepoRow }
        return try await get("/api/repos/\(id)", as: R.self).repo
    }

    func createRepo(_ input: RepoCreateInput) async throws -> RepoRow {
        struct R: Decodable { var repo: RepoRow }
        return try await post("/api/repos", body: input, as: R.self).repo
    }

    func updateRepo(_ id: String, _ input: RepoUpdateInput) async throws -> RepoRow {
        struct R: Decodable { var repo: RepoRow }
        return try await patch("/api/repos/\(id)", body: input, as: R.self).repo
    }

    func deleteRepo(_ id: String) async throws {
        try await delete("/api/repos/\(id)")
    }

    func validateRepo(url: String) async throws -> RepoValidation {
        struct B: Encodable { var repoUrl: String }
        return try await post("/api/setup/validate/repo", body: B(repoUrl: url), as: RepoValidation.self)
    }

    func recycleRepoPods(_ id: String) async throws -> Int {
        struct R: Decodable { var ok: Bool?; var recycled: Int? }
        return try await post("/api/repos/\(id)/pods/recycle", as: R.self).recycled ?? 0
    }

    func listSharedDirectories(repoId: String) async throws -> [SharedDirectoryRow] {
        struct R: Decodable { var directories: [SharedDirectoryRow] }
        return try await get("/api/repos/\(repoId)/shared-directories", as: R.self).directories
    }

    func createSharedDirectory(repoId: String, _ input: SharedDirectoryInput) async throws {
        try await post("/api/repos/\(repoId)/shared-directories", body: input)
    }

    func deleteSharedDirectory(repoId: String, dirId: String) async throws {
        try await delete("/api/repos/\(repoId)/shared-directories/\(dirId)")
    }

    func clearSharedDirectory(repoId: String, dirId: String) async throws {
        try await post("/api/repos/\(repoId)/shared-directories/\(dirId)/clear")
    }

    func sharedDirectoryUsage(repoId: String, dirId: String) async throws -> String? {
        struct R: Decodable { var usage: AnyCodable? }
        let usage = try await post("/api/repos/\(repoId)/shared-directories/\(dirId)/usage", as: R.self).usage
        guard let usage, !usage.isNull else { return nil }
        return usage.stringValue ?? usage.description
    }

    func listRepoConnections(repoId: String) async throws -> [ConnectionRow] {
        struct R: Decodable { var connections: [ConnectionRow] }
        return try await get("/api/repos/\(repoId)/connections", as: R.self).connections
    }

    func listRepoMcpServers(repoId: String) async throws -> [McpServerRow] {
        struct R: Decodable { var servers: [McpServerRow] }
        return try await get("/api/repos/\(repoId)/mcp-servers", as: R.self).servers
    }

    func createRepoMcpServer(repoId: String, _ input: McpServerInput) async throws {
        try await post("/api/repos/\(repoId)/mcp-servers", body: input)
    }

    // MCP servers
    func listMcpServers(scope: String? = nil) async throws -> [McpServerRow] {
        struct R: Decodable { var servers: [McpServerRow] }
        return try await get("/api/mcp-servers", query: ["scope": scope], as: R.self).servers
    }

    func createMcpServer(_ input: McpServerInput) async throws {
        try await post("/api/mcp-servers", body: input)
    }

    func setMcpServerEnabled(_ id: String, enabled: Bool) async throws {
        struct B: Encodable { var enabled: Bool }
        try await patch("/api/mcp-servers/\(id)", body: B(enabled: enabled), as: Empty.self)
    }

    func deleteMcpServer(_ id: String) async throws {
        try await delete("/api/mcp-servers/\(id)")
    }

    // Connections
    func listConnectionProviders() async throws -> [ConnectionProviderRow] {
        struct R: Decodable { var providers: [ConnectionProviderRow] }
        return try await get("/api/connection-providers", as: R.self).providers
    }

    func listConnections() async throws -> [ConnectionRow] {
        struct R: Decodable { var connections: [ConnectionRow] }
        return try await get("/api/connections", as: R.self).connections
    }

    func getConnection(_ id: String) async throws -> ConnectionRow {
        struct R: Decodable { var connection: ConnectionRow }
        return try await get("/api/connections/\(id)", as: R.self).connection
    }

    func createConnection(_ input: ConnectionCreateInput) async throws -> ConnectionRow {
        struct R: Decodable { var connection: ConnectionRow }
        return try await post("/api/connections", body: input, as: R.self).connection
    }

    func setConnectionEnabled(_ id: String, enabled: Bool) async throws {
        struct B: Encodable { var enabled: Bool }
        try await patch("/api/connections/\(id)", body: B(enabled: enabled), as: Empty.self)
    }

    func deleteConnection(_ id: String) async throws {
        try await delete("/api/connections/\(id)")
    }

    func testConnection(_ id: String) async throws -> ConnectionRow {
        struct R: Decodable { var connection: ConnectionRow }
        return try await post("/api/connections/\(id)/test", as: R.self).connection
    }

    func listConnectionAssignments(_ id: String) async throws -> [ConnectionAssignmentRow] {
        struct R: Decodable { var assignments: [ConnectionAssignmentRow] }
        return try await get("/api/connections/\(id)/assignments", as: R.self).assignments
    }

    func createConnectionAssignment(_ id: String, _ input: ConnectionAssignmentInput) async throws {
        try await post("/api/connections/\(id)/assignments", body: input)
    }

    func deleteConnectionAssignment(_ id: String) async throws {
        try await delete("/api/connection-assignments/\(id)")
    }

    // Secrets
    func listSecrets(scope: String? = nil) async throws -> [SecretRow] {
        struct R: Decodable { var secrets: [SecretRow] }
        return try await get("/api/secrets", query: ["scope": scope], as: R.self).secrets
    }

    func upsertSecret(name: String, value: String, scope: String) async throws -> SecretCreateResult {
        struct B: Encodable { var name: String; var value: String; var scope: String }
        return try await post("/api/secrets", body: B(name: name, value: value, scope: scope), as: SecretCreateResult.self)
    }

    func deleteSecret(name: String, scope: String?) async throws {
        let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? name
        var path = "/api/secrets/\(encoded)"
        if let scope, let q = scope.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) {
            path += "?scope=\(q)"
        }
        try await delete(path)
    }

    // Webhooks
    func listWebhooks() async throws -> [WebhookRow] {
        struct R: Decodable { var webhooks: [WebhookRow] }
        return try await get("/api/webhooks", as: R.self).webhooks
    }

    func getWebhook(_ id: String) async throws -> WebhookRow {
        struct R: Decodable { var webhook: WebhookRow }
        return try await get("/api/webhooks/\(id)", as: R.self).webhook
    }

    func createWebhook(_ input: WebhookCreateInput) async throws -> WebhookRow {
        struct R: Decodable { var webhook: WebhookRow }
        return try await post("/api/webhooks", body: input, as: R.self).webhook
    }

    func updateWebhook(_ id: String, _ input: WebhookUpdateInput) async throws -> WebhookRow {
        struct R: Decodable { var webhook: WebhookRow }
        return try await patch("/api/webhooks/\(id)", body: input, as: R.self).webhook
    }

    func deleteWebhook(_ id: String) async throws {
        try await delete("/api/webhooks/\(id)")
    }

    func testWebhook(_ id: String, event: String?) async throws -> WebhookDeliveryRow {
        struct B: Encodable { var event: String? }
        struct R: Decodable { var delivery: WebhookDeliveryRow }
        return try await post("/api/webhooks/\(id)/test", body: B(event: event), as: R.self).delivery
    }

    func listWebhookDeliveries(_ id: String, limit: Int = 50) async throws -> [WebhookDeliveryRow] {
        struct R: Decodable { var deliveries: [WebhookDeliveryRow] }
        return try await get("/api/webhooks/\(id)/deliveries", query: ["limit": String(limit)], as: R.self).deliveries
    }

    // Workspaces
    func listWorkspaces() async throws -> [WorkspaceRow] {
        struct R: Decodable { var workspaces: [WorkspaceRow] }
        return try await get("/api/workspaces", as: R.self).workspaces
    }

    func getWorkspace(_ id: String) async throws -> (workspace: WorkspaceRow, role: String?) {
        struct R: Decodable { var workspace: WorkspaceRow; var role: String? }
        let r = try await get("/api/workspaces/\(id)", as: R.self)
        return (r.workspace, r.role)
    }

    func createWorkspace(name: String, slug: String, description: String?) async throws -> WorkspaceRow {
        struct B: Encodable { var name: String; var slug: String; var description: String? }
        struct R: Decodable { var workspace: WorkspaceRow }
        return try await post("/api/workspaces", body: B(name: name, slug: slug, description: description), as: R.self).workspace
    }

    func updateWorkspace(_ id: String, name: String, slug: String, description: String?) async throws -> WorkspaceRow {
        struct B: Encodable { var name: String; var slug: String; var description: String? }
        struct R: Decodable { var workspace: WorkspaceRow }
        return try await patch("/api/workspaces/\(id)", body: B(name: name, slug: slug, description: description), as: R.self).workspace
    }

    func deleteWorkspace(_ id: String) async throws {
        try await delete("/api/workspaces/\(id)")
    }

    func switchWorkspace(_ id: String) async throws {
        try await post("/api/workspaces/\(id)/switch")
    }

    func listWorkspaceMembers(_ id: String) async throws -> [WorkspaceMemberRow] {
        struct R: Decodable { var members: [WorkspaceMemberRow] }
        return try await get("/api/workspaces/\(id)/members", as: R.self).members
    }

    func addWorkspaceMember(_ id: String, userId: String, role: String) async throws {
        struct B: Encodable { var userId: String; var role: String }
        try await post("/api/workspaces/\(id)/members", body: B(userId: userId, role: role))
    }

    func updateWorkspaceMemberRole(_ id: String, userId: String, role: String) async throws {
        struct B: Encodable { var role: String }
        try await patch("/api/workspaces/\(id)/members/\(userId)", body: B(role: role), as: Empty.self)
    }

    func removeWorkspaceMember(_ id: String, userId: String) async throws {
        try await delete("/api/workspaces/\(id)/members/\(userId)")
    }

    func lookupUser(email: String) async throws -> LookupUser {
        struct R: Decodable { var user: LookupUser }
        return try await get("/api/users/lookup", query: ["email": email], as: R.self).user
    }

    // Settings
    func getOptioSettings() async throws -> OptioSettingsRow {
        struct R: Decodable { var settings: OptioSettingsRow }
        return try await get("/api/optio/settings", as: R.self).settings
    }

    func updateOptioSettings(_ input: UpdateOptioSettingsInput) async throws -> OptioSettingsRow {
        struct R: Decodable { var settings: OptioSettingsRow }
        return try await put("/api/optio/settings", body: input, as: R.self).settings
    }

    func claudeAuthStatus() async throws -> ClaudeAuthStatus {
        try await get("/api/auth/status", as: ClaudeAuthStatus.self)
    }

    func refreshClaudeAuth() async throws {
        try await post("/api/auth/refresh")
    }

    func listAuthProviders() async throws -> (providers: [AuthProviderInfo], authDisabled: Bool) {
        struct R: Decodable { var providers: [AuthProviderInfo]; var authDisabled: Bool? }
        let r = try await get("/api/auth/providers", as: R.self)
        return (r.providers, r.authDisabled ?? false)
    }

    func listApiKeys() async throws -> [ApiKeyRow] {
        struct R: Decodable { var keys: [ApiKeyRow] }
        return try await get("/api/auth/api-keys", as: R.self).keys
    }

    func createApiKey(name: String, expiresAt: Date?) async throws -> CreatedApiKey {
        struct B: Encodable { var name: String; var expiresAt: String? }
        let iso = expiresAt.map { ISO8601DateFormatter().string(from: $0) }
        return try await post("/api/auth/api-keys", body: B(name: name, expiresAt: iso), as: CreatedApiKey.self)
    }

    func revokeApiKey(_ id: String) async throws {
        try await delete("/api/auth/api-keys/\(id)")
    }

    func getNotificationPreferences() async throws -> [String: NotificationPref] {
        struct R: Decodable { var preferences: [String: NotificationPref] }
        return try await get("/api/notifications/preferences", as: R.self).preferences
    }

    func updateNotificationPreferences(_ prefs: [String: NotificationPref]) async throws -> [String: NotificationPref] {
        struct R: Decodable { var preferences: [String: NotificationPref] }
        return try await put("/api/notifications/preferences", body: prefs, as: R.self).preferences
    }
}
