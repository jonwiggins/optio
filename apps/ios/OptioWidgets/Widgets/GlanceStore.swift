import Foundation
import WidgetKit

/// Extension-side persistence in App Group defaults: the last good snapshot per
/// server (so an offline reload renders stale-with-asOf instead of blank), local
/// snoozes written by `LaterIntent`, and the Run widget's armed/started timestamps.
enum GlanceStore {
    private static var defaults: UserDefaults { SharedCredentials.defaults }

    enum Keys {
        static func snapshot(_ serverId: String) -> String { "optio.glance.snapshot.\(serverId)" }
        static func tasks(_ serverId: String) -> String { "optio.glance.tasks.\(serverId)" }
        static func unreachableSince(_ serverId: String) -> String { "optio.glance.unreachableSince.\(serverId)" }
        static func snoozed(_ id: String) -> String { "optio.snoozed.\(id)" }
        static func armed(_ id: String) -> String { "optio.run.armed.\(id)" }
        static func started(_ id: String) -> String { "optio.run.started.\(id)" }
    }

    private static let encoder: JSONEncoder = { let e = JSONEncoder(); e.dateEncodingStrategy = .iso8601; return e }()
    private static let decoder: JSONDecoder = { let d = JSONDecoder(); d.dateDecodingStrategy = .iso8601; return d }()

    // MARK: Snapshot cache (per server)

    static func cachedSnapshot(for serverId: String) -> NeedsYouSnapshot? {
        defaults.data(forKey: Keys.snapshot(serverId)).flatMap { try? decoder.decode(NeedsYouSnapshot.self, from: $0) }
    }

    static func setCachedSnapshot(_ snapshot: NeedsYouSnapshot?, for serverId: String) {
        defaults.set(snapshot.flatMap { try? encoder.encode($0) }, forKey: Keys.snapshot(serverId))
    }

    static func cachedTasks(for serverId: String) -> [InFlightTask] {
        defaults.data(forKey: Keys.tasks(serverId)).flatMap { try? decoder.decode([InFlightTask].self, from: $0) } ?? []
    }

    static func setCachedTasks(_ tasks: [InFlightTask], for serverId: String) {
        defaults.set(try? encoder.encode(tasks), forKey: Keys.tasks(serverId))
    }

    /// First failed reload after the last success; cleared on success.
    static func unreachableSince(for serverId: String) -> Date? {
        defaults.object(forKey: Keys.unreachableSince(serverId)) as? Date
    }

    static func setUnreachableSince(_ date: Date?, for serverId: String) {
        defaults.set(date, forKey: Keys.unreachableSince(serverId))
    }

    /// Every paired server's last good snapshot merged (controls read this so they can
    /// say "Quiet" without a network call).
    static func mergedCachedSnapshot() -> NeedsYouSnapshot? {
        var merged: NeedsYouSnapshot?
        for server in ServerRegistry.configured {
            guard let s = cachedSnapshot(for: server.id) else { continue }
            if merged == nil { merged = s } else {
                merged!.needsYou += s.needsYou
                merged!.running += s.running
                merged!.hostsOnline += s.hostsOnline
                merged!.hostsTotal += s.hostsTotal
                merged!.asOf = min(merged!.asOf, s.asOf)
            }
        }
        return merged
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
    /// Set by the provider after decoding: which paired server the task came from.
    var serverId: String?
    var serverName: String?

    var since: Date { startedAt ?? updatedAt ?? createdAt ?? .distantPast }
    var branch: String { repoBranch ?? "" }
}
