import Foundation
import WidgetKit

/// Extension-side persistence in App Group defaults: the last good snapshot (so an
/// offline reload renders stale-with-asOf instead of blank), local snoozes written by
/// `LaterIntent`, and the Run widget's armed/started timestamps.
enum GlanceStore {
    private static var defaults: UserDefaults { SharedCredentials.defaults }

    enum Keys {
        static let snapshot = "optio.glance.snapshot"
        static let tasks = "optio.glance.tasks"
        static let unreachableSince = "optio.glance.unreachableSince"
        static func snoozed(_ id: String) -> String { "optio.snoozed.\(id)" }
        static func armed(_ id: String) -> String { "optio.run.armed.\(id)" }
        static func started(_ id: String) -> String { "optio.run.started.\(id)" }
    }

    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    // MARK: Snapshot cache

    static var cachedSnapshot: NeedsYouSnapshot? {
        get { defaults.data(forKey: Keys.snapshot).flatMap { try? decoder.decode(NeedsYouSnapshot.self, from: $0) } }
        set { defaults.set(newValue.flatMap { try? encoder.encode($0) }, forKey: Keys.snapshot) }
    }

    static var cachedTasks: [InFlightTask] {
        get { defaults.data(forKey: Keys.tasks).flatMap { try? decoder.decode([InFlightTask].self, from: $0) } ?? [] }
        set { defaults.set(try? encoder.encode(newValue), forKey: Keys.tasks) }
    }

    /// First failed reload after the last success; cleared on success.
    static var unreachableSince: Date? {
        get { defaults.object(forKey: Keys.unreachableSince) as? Date }
        set { defaults.set(newValue, forKey: Keys.unreachableSince) }
    }

    // MARK: Snooze (Later)

    static func snooze(_ id: String, until: Date) { defaults.set(until, forKey: Keys.snoozed(id)) }

    static func snoozedUntil(for ids: [String]) -> [String: Date] {
        var out: [String: Date] = [:]
        for id in ids { if let d = defaults.object(forKey: Keys.snoozed(id)) as? Date { out[id] = d } }
        return out
    }

    // MARK: Run widget

    static func armedAt(_ targetId: String) -> Date? { defaults.object(forKey: Keys.armed(targetId)) as? Date }
    static func setArmed(_ targetId: String, at date: Date?) { defaults.set(date, forKey: Keys.armed(targetId)) }
    static func startedAt(_ targetId: String) -> Date? { defaults.object(forKey: Keys.started(targetId)) as? Date }
    static func setStarted(_ targetId: String, at date: Date?) { defaults.set(date, forKey: Keys.started(targetId)) }
}

/// A Repo Task in flight, as much of `GET /api/tasks` as the In Flight widget needs.
/// Loose on purpose: every optional field may be missing on older servers.
struct InFlightTask: Codable, Hashable, Identifiable {
    var id: String
    var title: String
    var state: String
    var repoBranch: String?
    var prNumber: Int?
    var prUrl: String?
    var prChecksStatus: String?
    var startedAt: Date?
    var updatedAt: Date?
    var createdAt: Date?

    var since: Date { startedAt ?? updatedAt ?? createdAt ?? .distantPast }
    var branch: String { repoBranch ?? "" }
}
