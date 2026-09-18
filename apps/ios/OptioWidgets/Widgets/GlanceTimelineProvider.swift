import Foundation
import SwiftUI
import WidgetKit

/// One paired server's contribution to a glance: its snapshot, tasks and how much to trust them.
struct GlanceSlice: Hashable {
    let server: ServerProfile
    let reachability: GlancePolicy.Reachability
    let snapshot: NeedsYouSnapshot
    let tasks: [InFlightTask]
    /// First failed reload since the last success, when `reachability == .unreachable`.
    let unreachableSince: Date?

    var count: Int { snapshot.needsYou.count }
}

/// One timeline entry for every read-only widget: one slice per server the widget
/// shows (one when configured for a server, all paired servers otherwise) plus the
/// merged views the single-server layouts read.
struct GlanceEntry: TimelineEntry {
    let date: Date
    let slices: [GlanceSlice]

    /// True when the widget is showing more than one server (sectioned layouts).
    var isMulti: Bool { slices.count > 1 }
    /// True when other servers are paired even though this widget shows one, so the
    /// single-server layouts still name which server they are.
    let othersPaired: Bool

    init(date: Date, slices: [GlanceSlice], othersPaired: Bool = false) {
        self.date = date
        self.slices = slices
        self.othersPaired = othersPaired
    }

    var reachability: GlancePolicy.Reachability {
        if slices.isEmpty { return .signedOut }
        return slices.contains { $0.reachability == .live } ? .live : .unreachable
    }

    /// Servers that failed their last reload while others answered.
    var unreachableSlices: [GlanceSlice] { slices.filter { $0.reachability == .unreachable } }

    var snapshot: NeedsYouSnapshot {
        guard slices.count != 1 else { return slices[0].snapshot }
        var merged = NeedsYouSnapshot.empty
        merged.asOf = .distantFuture
        for s in slices {
            merged.needsYou += s.snapshot.needsYou
            merged.running += s.snapshot.running
            merged.hostsOnline += s.snapshot.hostsOnline
            merged.hostsTotal += s.snapshot.hostsTotal
            merged.asOf = min(merged.asOf, s.snapshot.asOf)
        }
        if merged.asOf == .distantFuture { merged.asOf = date }
        // Oldest first across servers, snoozed items (already at the back per slice) last.
        merged.needsYou.sort { a, b in
            let (sa, sb) = (a.isSnoozed(at: date), b.isSnoozed(at: date))
            return sa == sb ? a.since < b.since : !sa
        }
        merged.running.sort { $0.since > $1.since }
        return merged
    }

    var tasks: [InFlightTask] { slices.flatMap(\.tasks) }
    var asOf: Date { snapshot.asOf }
    var isStale: Bool { GlancePolicy.isStale(asOf: asOf, now: date) }
    var needsYou: [WatchItem] { snapshot.needsYou }
    var running: [WatchItem] { snapshot.running }
    var count: Int { snapshot.needsYou.count }
    var unreachableSince: Date? { unreachableSlices.compactMap(\.unreachableSince).min() }

    /// The one server a single-server layout labels itself with (nil when showing all).
    var server: ServerProfile? { slices.count == 1 ? slices[0].server : nil }
    /// Whether single-server layouts should show the server name at all.
    var showsServerName: Bool { server != nil && othersPaired }

    static func signedOut(at date: Date = .now) -> GlanceEntry {
        GlanceEntry(date: date, slices: [])
    }
}

/// Provider for the Agents widget: one fetch per server per reload via
/// `SharedFetch`, last good snapshot cached per server in App Group defaults,
/// cadence from `GlancePolicy`.
struct GlanceTimelineProvider: AppIntentTimelineProvider {
    typealias Intent = GlanceConfigurationIntent

    /// Also list Repo Tasks in flight (the large family shows them).
    var includeTasks = false

    func placeholder(in context: Context) -> GlanceEntry { GlanceFixtures.waiting }

    func snapshot(for configuration: GlanceConfigurationIntent, in context: Context) async -> GlanceEntry {
        if context.isPreview { return GlanceFixtures.waiting }
        return await load(configuration, now: .now)
    }

    func timeline(for configuration: GlanceConfigurationIntent, in context: Context) async -> Timeline<GlanceEntry> {
        let now = Date.now
        let entry = await load(configuration, now: now)
        let interval = GlancePolicy.refreshInterval(entry.reachability, anyRunning: !entry.running.isEmpty, anyNeedsYou: !entry.needsYou.isEmpty)
        var entries = [entry]
        // Flip to the "as of HH:mm" footer at the staleness boundary without a reload.
        let staleAt = entry.asOf.addingTimeInterval(GlancePolicy.staleAfter)
        if entry.reachability == .live, staleAt > now, staleAt < now.addingTimeInterval(interval) {
            entries.append(GlanceEntry(date: staleAt, slices: entry.slices, othersPaired: entry.othersPaired))
        }
        return Timeline(entries: entries, policy: .after(now.addingTimeInterval(interval)))
    }

    // MARK: Loading

    /// The servers this configuration covers: the chosen one (if still paired), else all.
    static func servers(for configuration: GlanceConfigurationIntent) -> [ServerProfile] {
        let all = ServerRegistry.configured
        if let chosen = configuration.server?.id, let p = all.first(where: { $0.id == chosen }) { return [p] }
        return all
    }

    func load(_ configuration: GlanceConfigurationIntent, now: Date) async -> GlanceEntry {
        let servers = Self.servers(for: configuration)
        guard !servers.isEmpty else { return .signedOut(at: now) }
        let othersPaired = ServerRegistry.configured.count > servers.count
        let includeTasks = includeTasks
        var slices: [GlanceSlice] = []
        await withTaskGroup(of: GlanceSlice.self) { group in
            for server in servers { group.addTask { await Self.loadSlice(server, includeTasks: includeTasks, now: now) } }
            for await slice in group { slices.append(slice) }
        }
        // Stable order: as paired, active first (the registry's order).
        let order = Dictionary(uniqueKeysWithValues: servers.enumerated().map { ($1.id, $0) })
        slices.sort { (order[$0.server.id] ?? 0) < (order[$1.server.id] ?? 0) }
        return GlanceEntry(date: now, slices: slices, othersPaired: othersPaired)
    }

    static func loadSlice(_ server: ServerProfile, includeTasks: Bool, now: Date) async -> GlanceSlice {
        guard let fetch = SharedFetch(server: server) else {
            return GlanceSlice(server: server, reachability: .unreachable, snapshot: .empty, tasks: [], unreachableSince: now)
        }
        async let snapshotTask = loadSnapshot(fetch)
        async let tasksTask = includeTasks ? loadTasks(fetch) : nil
        let (snapshot, tasks) = await (snapshotTask, tasksTask)

        if let snapshot {
            GlanceStore.setCachedSnapshot(snapshot, for: server.id)
            GlanceStore.setUnreachableSince(nil, for: server.id)
            if let tasks { GlanceStore.setCachedTasks(tasks, for: server.id) }
            return GlanceSlice(server: server, reachability: .live, snapshot: ordered(snapshot, now: now),
                               tasks: tasks ?? GlanceStore.cachedTasks(for: server.id), unreachableSince: nil)
        }
        // Unreachable: keep the last good snapshot and say since when.
        let since = GlanceStore.unreachableSince(for: server.id) ?? now
        GlanceStore.setUnreachableSince(since, for: server.id)
        let cached = GlanceStore.cachedSnapshot(for: server.id) ?? .empty
        return GlanceSlice(server: server, reachability: .unreachable, snapshot: ordered(cached, now: now),
                           tasks: GlanceStore.cachedTasks(for: server.id), unreachableSince: since)
    }

    private static func loadSnapshot(_ fetch: SharedFetch) async -> NeedsYouSnapshot? {
        try? await NeedsYouSnapshot.load(using: fetch)
    }

    private struct TasksEnvelope: Decodable { let tasks: [InFlightTask] }

    private static func loadTasks(_ fetch: SharedFetch) async -> [InFlightTask]? {
        guard let env = try? await fetch.get("/api/tasks", query: ["limit": "5", "type": "repo-task"], as: TasksEnvelope.self) else { return nil }
        return env.tasks.filter { $0.state == "running" || $0.state == "pr_opened" }.prefix(3).map {
            var t = $0
            t.serverId = fetch.serverId
            t.serverName = fetch.serverName
            return t
        }
    }

    /// Oldest first, with locally snoozed items (Later) moved to the back.
    static func ordered(_ snapshot: NeedsYouSnapshot, now: Date) -> NeedsYouSnapshot {
        var s = snapshot
        let sorted = s.needsYou.sorted { $0.since < $1.since }
        let snoozes = GlanceStore.snoozedUntil(for: sorted.map(\.id))
        s.needsYou = GlancePolicy.applySnooze(sorted, id: \.id, snoozedUntil: snoozes, now: now).map { item in
            // Mirror a local "Later" onto the item so merged (multi-server) ordering sees it too.
            var item = item
            if let local = snoozes[item.id], local > now, (item.snoozedUntil ?? .distantPast) < local { item.snoozedUntil = local }
            return item
        }
        s.running = s.running.sorted { $0.since > $1.since }
        return s
    }
}

// MARK: - Fixtures (placeholders + previews)

enum GlanceFixtures {
    static let now = Date.now
    static let laptop = ServerProfile(id: "srv-laptop", name: "MacBook Pro", url: URL(string: "http://laptop.tailnet.ts.net:30400")!, color: .slate)
    static let studio = ServerProfile(id: "srv-studio", name: "Studio", url: URL(string: "http://studio.tailnet.ts.net:30400")!, color: .teal)

    static let web = WatchItem(kind: .local, id: "t-web", title: "claude-code · web", mono: "optio/apps/web", reason: "Waiting on a permission", preview: "Allow Bash(pnpm test)?", since: now.addingTimeInterval(-4 * 60), state: "needs_you", link: DeepLink.local("t-web", compose: true).url(server: laptop.id).absoluteString, serverId: laptop.id, serverName: laptop.shortName)
    static let api = WatchItem(kind: .local, id: "t-api", title: "claude-code · api", mono: "optio/apps/api", reason: "Claude stopped — reply to continue", since: now.addingTimeInterval(-11 * 60), state: "needs_you", link: DeepLink.local("t-api", compose: true).url(server: laptop.id).absoluteString, serverId: laptop.id, serverName: laptop.shortName)
    static let forge = WatchItem(kind: .agent, id: "a-vesper", title: "Vesper", mono: "vesper", reason: "Gone quiet", since: now.addingTimeInterval(-38 * 60), state: "needs_you", link: DeepLink.agent("a-vesper", compose: true).url(server: studio.id).absoluteString, serverId: studio.id, serverName: studio.shortName)
    static let cli = WatchItem(kind: .local, id: "t-cli", title: "codex · cli", mono: "optio/apps/cli", since: now.addingTimeInterval(-23 * 60), state: "working", link: DeepLink.local("t-cli", compose: false).url(server: laptop.id).absoluteString, serverId: laptop.id, serverName: laptop.shortName)
    static let docs = WatchItem(kind: .local, id: "t-docs", title: "claude-code · docs", mono: "optio/docs", since: now.addingTimeInterval(-2 * 60), state: "working", link: DeepLink.local("t-docs", compose: false).url(server: studio.id).absoluteString, serverId: studio.id, serverName: studio.shortName)

    static let tasks = [
        InFlightTask(id: "task-1", title: "fix: login redirect loops on expired PAT", state: "pr_opened", repoBranch: "fix/login-redirect", prNumber: 581, prUrl: "https://github.com/jonwiggins/optio/pull/581", prChecksStatus: "pending", startedAt: now.addingTimeInterval(-52 * 60), serverId: laptop.id, serverName: laptop.shortName),
        InFlightTask(id: "task-2", title: "feat(ios): widgets and controls", state: "running", repoBranch: "feat/ios-widgets", startedAt: now.addingTimeInterval(-12 * 60), serverId: studio.id, serverName: studio.shortName),
    ]

    static func slice(_ server: ServerProfile, needs: [WatchItem], running: [WatchItem], tasks: [InFlightTask] = [], asOf: Date = now, reachability: GlancePolicy.Reachability = .live, unreachableSince: Date? = nil, hostsOnline: Int = 1) -> GlanceSlice {
        GlanceSlice(server: server, reachability: reachability, snapshot: NeedsYouSnapshot(needsYou: needs, running: running, hostsOnline: hostsOnline, hostsTotal: 1, asOf: asOf), tasks: tasks, unreachableSince: unreachableSince)
    }

    static let waiting = GlanceEntry(date: now, slices: [slice(laptop, needs: [web, api], running: [cli], tasks: [tasks[0]]), slice(studio, needs: [forge], running: [docs], tasks: [tasks[1]])])
    static let one = GlanceEntry(date: now, slices: [slice(laptop, needs: [web], running: [cli], tasks: tasks)], othersPaired: true)
    static let single = GlanceEntry(date: now, slices: [slice(laptop, needs: [web, api], running: [cli], tasks: tasks)])
    static let quiet = GlanceEntry(date: now, slices: [slice(laptop, needs: [], running: [cli], tasks: tasks), slice(studio, needs: [], running: [docs])])
    static let idle = GlanceEntry(date: now, slices: [slice(laptop, needs: [], running: [])])
    static let offline = GlanceEntry(date: now, slices: [slice(laptop, needs: [web], running: [cli], tasks: tasks, asOf: now.addingTimeInterval(-47 * 60), reachability: .unreachable, unreachableSince: now.addingTimeInterval(-41 * 60), hostsOnline: 0)])
    static let partial = GlanceEntry(date: now, slices: [slice(laptop, needs: [web], running: [cli], tasks: [tasks[0]]), slice(studio, needs: [], running: [], asOf: now.addingTimeInterval(-20 * 60), reachability: .unreachable, unreachableSince: now.addingTimeInterval(-9 * 60))])
    static let stale = GlanceEntry(date: now, slices: [slice(laptop, needs: [web, api], running: [cli], tasks: tasks, asOf: now.addingTimeInterval(-35 * 60))])
    static let signedOut = GlanceEntry.signedOut(at: now)
}
