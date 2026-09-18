import AppIntents
import Foundation

/// Something the Run widget/control can fire: a Local blueprint (`GET /api/local/blueprints`)
/// or a Job (`GET /api/jobs`) on one of the paired servers. The id is namespaced
/// (`<serverId>|local:<uuid>` / `<serverId>|job:<uuid>`) so one picker lists every
/// server's targets; ids without the server prefix (configured before multi-server)
/// fire on the active server.
struct RunTargetEntity: AppEntity, Identifiable, Hashable {
    enum Kind: String, Codable, Hashable { case local, job }

    static let typeDisplayRepresentation = TypeDisplayRepresentation(name: "Optio Blueprint")
    static let defaultQuery = RunTargetQuery()

    var id: String
    var name: String
    var kind: Kind
    /// Local blueprints with `spawn_mode=auto` start an agent immediately; "hold" waits in the cockpit.
    var spawnMode: String?
    /// Short name of the server this target lives on; shown when several are paired.
    var serverName: String?

    var displayRepresentation: DisplayRepresentation {
        let kindLabel = kind == .local ? "Local blueprint" : "Job"
        let subtitle = serverName.map { "\(kindLabel) · \($0)" } ?? kindLabel
        return DisplayRepresentation(title: "\(name)", subtitle: "\(subtitle)")
    }

    init(id: String, name: String, kind: Kind, spawnMode: String? = nil, serverName: String? = nil) {
        self.id = id
        self.name = name
        self.kind = kind
        self.spawnMode = spawnMode
        self.serverName = serverName
    }

    static func makeId(serverId: String?, kind: Kind, rawId: String) -> String {
        let base = "\(kind.rawValue):\(rawId)"
        return serverId.map { "\($0)|\(base)" } ?? base
    }

    /// Splits `[<serverId>|]local:<uuid>` / `[<serverId>|]job:<uuid>` back into its parts.
    static func parse(_ id: String) -> (kind: Kind, rawId: String, serverId: String?)? {
        var serverId: String?
        var rest = Substring(id)
        if let bar = rest.firstIndex(of: "|") {
            serverId = String(rest[..<bar])
            rest = rest[rest.index(after: bar)...]
        }
        guard let colon = rest.firstIndex(of: ":"), let kind = Kind(rawValue: String(rest[..<colon])) else { return nil }
        return (kind, String(rest[rest.index(after: colon)...]), serverId)
    }

    var serverId: String? { Self.parse(id)?.serverId }

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

    /// Both lists on every paired server, active server first, blueprints before jobs;
    /// each request fails independently.
    static func fetchAll() async -> [RunTargetEntity] {
        let clients = SharedFetch.allServers
        let multi = clients.count > 1
        var out: [RunTargetEntity] = []
        for fetch in clients {
            async let blueprints = try? fetch.get("/api/local/blueprints", as: BlueprintsEnvelope.self)
            async let jobs = try? fetch.get("/api/jobs", as: JobsEnvelope.self)
            let (b, j) = await (blueprints, jobs)
            let label = multi ? fetch.serverName : nil
            out += (b?.blueprints ?? []).map { RunTargetEntity(id: makeId(serverId: fetch.serverId, kind: .local, rawId: $0.id), name: $0.name, kind: .local, spawnMode: $0.spawnMode, serverName: label) }
            out += (j?.workflows ?? []).filter { $0.enabled ?? true }.map { RunTargetEntity(id: makeId(serverId: fetch.serverId, kind: .job, rawId: $0.id), name: $0.name, kind: .job, serverName: label) }
        }
        return out
    }
}

struct RunTargetQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [RunTargetEntity] {
        let all = await RunTargetEntity.fetchAll()
        var found = all.filter { identifiers.contains($0.id) }
        // Legacy ids (no server prefix) match the same target on the active server.
        for id in identifiers where !found.contains(where: { $0.id == id }) {
            if let p = RunTargetEntity.parse(id), p.serverId == nil,
               let match = all.first(where: { RunTargetEntity.parse($0.id).map { $0.kind == p.kind && $0.rawId == p.rawId } ?? false }) {
                var legacy = match
                legacy.id = id
                found.append(legacy)
            }
        }
        if found.count == identifiers.count { return found }
        // Offline or deleted: keep the configured id resolvable so the widget still renders its name.
        let missing = identifiers.filter { id in !found.contains { $0.id == id } }.compactMap { id -> RunTargetEntity? in
            guard let p = RunTargetEntity.parse(id) else { return nil }
            return RunTargetEntity(id: id, name: p.kind == .local ? "Blueprint" : "Job", kind: p.kind,
                                   serverName: p.serverId.flatMap { ServerRegistry.profile($0)?.shortName })
        }
        return found + missing
    }

    func suggestedEntities() async throws -> [RunTargetEntity] { await RunTargetEntity.fetchAll() }
}
