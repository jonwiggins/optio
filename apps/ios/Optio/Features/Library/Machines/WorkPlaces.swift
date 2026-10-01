import Foundation

// Where work runs, for the Machines screen: the Work feed sorted into each
// paired machine (by `where.hostId`) and the Optio pods (grouped by repo, Jobs,
// and persistent agents). A port of the web's `apps/web/src/lib/work-places.ts`;
// pure, so `OptioTests/WorkPlacesTests.swift` mirrors its tests.

/// The work at one place: what is live now, and what is set up to run there.
struct PlaceWork: Hashable, Sendable {
    /// Running, queued, waiting, or needing you — needs-you first.
    var now: [WorkRow] = []
    /// Recurring definitions (automations, Jobs, scheduled Tasks) and standing agents.
    var setUp: [WorkRow] = []

    var isEmpty: Bool { now.isEmpty && setUp.isEmpty }

    /// "1 needs you · 2 active", or nil when nothing is live.
    var nowSummary: String? {
        let needsYou = now.filter { $0.status == .needsYou }.count
        let live = now.count - needsYou
        let parts = [
            needsYou > 0 ? "\(needsYou) need\(needsYou == 1 ? "s" : "") you" : nil,
            live > 0 ? "\(live) active" : nil,
        ].compactMap { $0 }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}

struct PodGroup: Hashable, Sendable, Identifiable {
    enum Kind: Int, Hashable, Sendable { case repo = 0, jobs, agents, other }
    /// `repo:<owner/name>`, `jobs`, `agents`, or `other`.
    let id: String
    let kind: Kind
    /// "acme/app", "Jobs", "Persistent agents", "Other".
    let label: String
    var work = PlaceWork()

    var systemImage: String {
        switch kind {
        case .repo: return "arrow.triangle.branch"
        case .jobs: return "briefcase"
        case .agents: return "cpu"
        case .other: return "server.rack"
        }
    }
}

struct WorkPlaces: Hashable, Sendable {
    /// Per paired machine id; every id passed in has an entry, empty or not.
    var machines: [String: PlaceWork] = [:]
    /// Machine work whose machine isn't one of the caller's (or has none set).
    var otherMachines = PlaceWork()
    /// Repos first (busiest first, then by name), then Jobs, agents, other.
    var pods: [PodGroup] = []

    init(rows: [WorkRow], hostIds: [String]) {
        for id in hostIds { machines[id] = PlaceWork() }
        var groups: [String: PodGroup] = [:]

        for row in WorkFeed.sort(rows) {
            guard let half = Self.half(of: row) else { continue }
            if row.where.target == .machine {
                if let id = row.where.hostId, machines[id] != nil {
                    Self.append(row, to: &machines[id]!, half)
                } else {
                    Self.append(row, to: &otherMachines, half)
                }
                continue
            }
            let g = Self.group(of: row)
            var group = groups[g.id] ?? g
            Self.append(row, to: &group.work, half)
            groups[g.id] = group
        }

        for id in machines.keys { machines[id]!.now = Self.needsYouFirst(machines[id]!.now) }
        otherMachines.now = Self.needsYouFirst(otherMachines.now)
        pods = groups.values
            .map { var g = $0; g.work.now = Self.needsYouFirst(g.work.now); return g }
            .sorted { a, b in
                if a.kind != b.kind { return a.kind.rawValue < b.kind.rawValue }
                if a.work.now.count != b.work.now.count { return a.work.now.count > b.work.now.count }
                return a.label.localizedCaseInsensitiveCompare(b.label) == .orderedAscending
            }
    }

    private enum Half { case now, setUp }

    /// Which half a row belongs in, or nil when it is history: a persistent agent
    /// that isn't archived is standing work even while idle.
    private static func half(of row: WorkRow) -> Half? {
        if WorkFeed.inView(row, .active) { return .now }
        if row.recurring { return .setUp }
        if row.source == .persistentAgent, row.status != .done { return .setUp }
        return nil
    }

    private static func append(_ row: WorkRow, to place: inout PlaceWork, _ half: Half) {
        switch half {
        case .now: place.now.append(row)
        case .setUp: place.setUp.append(row)
        }
    }

    private static func group(of row: WorkRow) -> PodGroup {
        if row.source == .persistentAgent { return PodGroup(id: "agents", kind: .agents, label: "Persistent agents") }
        if row.source == .standalone { return PodGroup(id: "jobs", kind: .jobs, label: "Jobs") }
        // Repo Tasks, scheduled Tasks and pod sessions are named by their repo.
        if let repo = row.where.detail, !repo.isEmpty { return PodGroup(id: "repo:\(repo)", kind: .repo, label: repo) }
        return PodGroup(id: "other", kind: .other, label: "Other")
    }

    private static func needsYouFirst(_ rows: [WorkRow]) -> [WorkRow] {
        rows.filter { $0.status == .needsYou } + rows.filter { $0.status != .needsYou }
    }
}
