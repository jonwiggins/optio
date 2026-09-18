import AppIntents
import Foundation

// MARK: - Terminal

struct TerminalEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Terminal")
    static let defaultQuery = TerminalQuery()

    let id: String
    @Property(title: "Title") var title: String
    /// Last path segment of the working directory (the mono label on every surface).
    @Property(title: "Directory") var directory: String
    @Property(title: "State") var state: String
    @Property(title: "Needs you") var needsYou: Bool
    @Property(title: "Reason") var reason: String?

    init(_ t: LocalTerminal) {
        id = t.id
        title = t.title
        directory = (t.dir as NSString).lastPathComponent
        state = t.attentionState == .needsYou ? "needs_you" : t.state.rawValue
        needsYou = t.attentionState == .needsYou
        reason = t.attentionState == .needsYou ? LocalPresentation.attentionLabel(t.attentionReason) : nil
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(
            title: "\(directory)",
            subtitle: "\(reason ?? title)",
            image: .init(systemName: needsYou ? "exclamationmark.bubble.fill" : "terminal"))
    }
}

struct TerminalQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TerminalEntity] {
        let api = try await IntentContext.api()
        var out: [TerminalEntity] = []
        for id in identifiers {
            if let t = try? await api.getLocalTerminal(id) { out.append(TerminalEntity(t)) }
        }
        return out
    }

    func entities(matching string: String) async throws -> [TerminalEntity] {
        let needle = string.lowercased()
        return try await live().filter {
            $0.title.lowercased().contains(needle) || $0.directory.lowercased().contains(needle)
        }
    }

    func suggestedEntities() async throws -> [TerminalEntity] {
        try await live()
    }

    /// Running agent terminals, needs-you first.
    private func live() async throws -> [TerminalEntity] {
        let api = try await IntentContext.api()
        let terms = try await api.listLocalTerminals(state: "running")
        return terms
            .filter { $0.isAgentTerminal }
            .sorted { ($0.attentionState == .needsYou ? 0 : 1) < ($1.attentionState == .needsYou ? 0 : 1) }
            .map(TerminalEntity.init)
    }
}

// MARK: - Task

struct TaskEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Task")
    static let defaultQuery = TaskQuery()

    let id: String
    @Property(title: "Title") var title: String
    @Property(title: "Branch") var branch: String?
    @Property(title: "State") var state: String
    @Property(title: "PR URL") var prUrl: String?

    init(_ t: TaskRow) {
        id = t.id
        title = t.title
        branch = t.repoBranch
        state = t.state
        prUrl = t.prUrl
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(title)", subtitle: "\(state.replacingOccurrences(of: "_", with: " "))\(branch.map { " · \($0)" } ?? "")")
    }
}

struct TaskQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [TaskEntity] {
        let api = try await IntentContext.api()
        var out: [TaskEntity] = []
        for id in identifiers {
            if let t = try? await api.getTask(id) { out.append(TaskEntity(t.task)) }
        }
        return out
    }

    func entities(matching string: String) async throws -> [TaskEntity] {
        let api = try await IntentContext.api()
        return try await api.searchTasks(q: string, limit: 25).tasks.map(TaskEntity.init)
    }

    func suggestedEntities() async throws -> [TaskEntity] {
        let api = try await IntentContext.api()
        let rows = try await api.listTasks(limit: 40)
        let interesting: Set<String> = ["needs_attention", "failed", "running", "pr_opened", "queued"]
        return rows.filter { interesting.contains($0.state) }.prefix(15).map(TaskEntity.init)
    }
}

// MARK: - Agent

struct AgentEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Agent")
    static let defaultQuery = AgentQuery()

    let id: String
    @Property(title: "Name") var name: String
    @Property(title: "Slug") var slug: String
    @Property(title: "State") var state: String

    init(_ a: PersistentAgent) {
        id = a.id
        name = a.name
        slug = a.slug
        state = a.state.rawValue
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(slug) · \(state)", image: .init(systemName: "person.wave.2"))
    }
}

struct AgentQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [AgentEntity] {
        let all = try await all()
        return all.filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [AgentEntity] {
        let needle = string.lowercased()
        return try await all().filter { $0.name.lowercased().contains(needle) || $0.slug.lowercased().contains(needle) }
    }

    func suggestedEntities() async throws -> [AgentEntity] {
        try await all().filter { $0.state != "archived" }
    }

    private func all() async throws -> [AgentEntity] {
        let api = try await IntentContext.api()
        return try await api.listPersistentAgents().map(AgentEntity.init)
    }
}

// MARK: - Blueprint (Optio Local)

struct BlueprintEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Blueprint")
    static let defaultQuery = BlueprintQuery()

    let id: String
    @Property(title: "Name") var name: String
    @Property(title: "Spawn mode") var spawnMode: String
    @Property(title: "Enabled") var enabled: Bool

    init(_ b: LocalBlueprint) {
        id = b.id
        name = b.name
        spawnMode = b.spawnMode.rawValue
        enabled = b.enabled
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: spawnMode == "auto" ? "starts immediately" : "held until you start it", image: .init(systemName: "doc.text"))
    }
}

struct BlueprintQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [BlueprintEntity] {
        try await all().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [BlueprintEntity] {
        let needle = string.lowercased()
        return try await all().filter { $0.name.lowercased().contains(needle) }
    }

    func suggestedEntities() async throws -> [BlueprintEntity] {
        try await all().filter(\.enabled)
    }

    private func all() async throws -> [BlueprintEntity] {
        let api = try await IntentContext.api()
        return try await api.listLocalBlueprints().map(BlueprintEntity.init)
    }
}

// MARK: - Job (standalone workflow)

struct JobEntity: AppEntity, Identifiable {
    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Job")
    static let defaultQuery = JobQuery()

    let id: String
    @Property(title: "Name") var name: String
    @Property(title: "Enabled") var enabled: Bool

    init(_ j: JobSummary) {
        id = j.id
        name = j.name
        enabled = j.enabled ?? true
    }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", image: .init(systemName: "play.square"))
    }
}

struct JobQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [JobEntity] {
        try await all().filter { identifiers.contains($0.id) }
    }

    func entities(matching string: String) async throws -> [JobEntity] {
        let needle = string.lowercased()
        return try await all().filter { $0.name.lowercased().contains(needle) }
    }

    func suggestedEntities() async throws -> [JobEntity] {
        try await all().filter(\.enabled)
    }

    private func all() async throws -> [JobEntity] {
        let api = try await IntentContext.api()
        return try await api.listJobs().map(JobEntity.init)
    }
}
