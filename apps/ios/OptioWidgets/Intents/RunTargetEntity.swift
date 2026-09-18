import AppIntents
import Foundation

/// Something the Run widget/control can fire: a Local blueprint (`GET /api/local/blueprints`)
/// or a Job (`GET /api/jobs`). The id is namespaced (`local:<uuid>` / `job:<uuid>`) so one
/// picker lists both.
struct RunTargetEntity: AppEntity, Identifiable, Hashable {
    enum Kind: String, Codable, Hashable { case local, job }

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Optio Blueprint")
    static let defaultQuery = RunTargetQuery()

    var id: String
    var name: String
    var kind: Kind
    /// Local blueprints with `spawn_mode=auto` start an agent immediately; "hold" waits in the cockpit.
    var spawnMode: String?

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: kind == .local ? "Local blueprint" : "Job")
    }

    init(id: String, name: String, kind: Kind, spawnMode: String? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.spawnMode = spawnMode
    }

    /// Splits `local:<uuid>` / `job:<uuid>` back into its parts.
    static func parse(_ id: String) -> (kind: Kind, rawId: String)? {
        guard let colon = id.firstIndex(of: ":"), let kind = Kind(rawValue: String(id[..<colon])) else { return nil }
        return (kind, String(id[id.index(after: colon)...]))
    }

    /// `POST` path that fires this target.
    var firePath: String? {
        guard let parts = Self.parse(id) else { return nil }
        switch parts.kind {
        case .local: return "/api/local/blueprints/\(parts.rawId)/spawn"
        case .job: return "/api/jobs/\(parts.rawId)/runs"
        }
    }

    // MARK: Fetching

    private struct BlueprintRow: Decodable { let id: String; let name: String; let spawnMode: String? }
    private struct BlueprintsEnvelope: Decodable { let blueprints: [BlueprintRow] }
    private struct JobRow: Decodable { let id: String; let name: String; let enabled: Bool? }
    private struct JobsEnvelope: Decodable { let workflows: [JobRow] }

    /// Both lists, blueprints first; each request fails independently.
    static func fetchAll() async -> [RunTargetEntity] {
        guard let fetch = SharedFetch() else { return [] }
        async let blueprints = try? fetch.get("/api/local/blueprints", as: BlueprintsEnvelope.self)
        async let jobs = try? fetch.get("/api/jobs", as: JobsEnvelope.self)
        let (b, j) = await (blueprints, jobs)
        let local = (b?.blueprints ?? []).map { RunTargetEntity(id: "local:\($0.id)", name: $0.name, kind: .local, spawnMode: $0.spawnMode) }
        let job = (j?.workflows ?? []).filter { $0.enabled ?? true }.map { RunTargetEntity(id: "job:\($0.id)", name: $0.name, kind: .job) }
        return local + job
    }
}

struct RunTargetQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [RunTargetEntity] {
        let all = await RunTargetEntity.fetchAll()
        let found = all.filter { identifiers.contains($0.id) }
        if found.count == identifiers.count { return found }
        // Offline or deleted: keep the configured id resolvable so the widget still renders its name.
        let missing = identifiers.filter { id in !found.contains { $0.id == id } }.compactMap { id -> RunTargetEntity? in
            guard let p = RunTargetEntity.parse(id) else { return nil }
            return RunTargetEntity(id: id, name: p.kind == .local ? "Blueprint" : "Job", kind: p.kind)
        }
        return found + missing
    }

    func suggestedEntities() async throws -> [RunTargetEntity] { await RunTargetEntity.fetchAll() }
}
