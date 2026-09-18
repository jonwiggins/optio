import Foundation
import SwiftUI
import WidgetKit

/// One timeline entry for every read-only widget: the snapshot plus how much to trust it.
struct GlanceEntry: TimelineEntry {
    let date: Date
    let reachability: GlancePolicy.Reachability
    let snapshot: NeedsYouSnapshot
    let tasks: [InFlightTask]
    /// First failed reload since the last success, when `reachability == .unreachable`.
    let unreachableSince: Date?

    var asOf: Date { snapshot.asOf }
    var isStale: Bool { GlancePolicy.isStale(asOf: asOf, now: date) }
    var needsYou: [WatchItem] { snapshot.needsYou }
    var running: [WatchItem] { snapshot.running }
    var count: Int { snapshot.needsYou.count }

    static func signedOut(at date: Date = .now) -> GlanceEntry {
        GlanceEntry(date: date, reachability: .signedOut, snapshot: .empty, tasks: [], unreachableSince: nil)
    }
}

/// Shared provider for Needs You and In Flight: one fetch per reload via `SharedFetch`,
/// last good snapshot cached in App Group defaults, cadence from `GlancePolicy`.
struct GlanceTimelineProvider: TimelineProvider {
    /// In Flight (large) also lists Repo Tasks; the others skip that request.
    var includeTasks = false

    func placeholder(in context: Context) -> GlanceEntry { GlanceFixtures.waiting }

    func getSnapshot(in context: Context, completion: @escaping (GlanceEntry) -> Void) {
        if context.isPreview { completion(GlanceFixtures.waiting); return }
        Task { completion(await load(now: .now)) }
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<GlanceEntry>) -> Void) {
        Task {
            let now = Date.now
            let entry = await load(now: now)
            let interval = GlancePolicy.refreshInterval(entry.reachability, anyRunning: !entry.running.isEmpty, anyNeedsYou: !entry.needsYou.isEmpty)
            var entries = [entry]
            // Flip to the "as of HH:mm" footer at the staleness boundary without a reload.
            let staleAt = entry.asOf.addingTimeInterval(GlancePolicy.staleAfter)
            if entry.reachability == .live, staleAt > now, staleAt < now.addingTimeInterval(interval) {
                entries.append(GlanceEntry(date: staleAt, reachability: entry.reachability, snapshot: entry.snapshot, tasks: entry.tasks, unreachableSince: entry.unreachableSince))
            }
            completion(Timeline(entries: entries, policy: .after(now.addingTimeInterval(interval))))
        }
    }

    // MARK: Loading

    func load(now: Date) async -> GlanceEntry {
        guard let fetch = SharedFetch() else { return .signedOut(at: now) }
        async let snapshotTask = Self.loadSnapshot(fetch)
        async let tasksTask = includeTasks ? Self.loadTasks(fetch) : nil
        let (snapshot, tasks) = await (snapshotTask, tasksTask)

        if let snapshot {
            GlanceStore.cachedSnapshot = snapshot
            GlanceStore.unreachableSince = nil
            if let tasks { GlanceStore.cachedTasks = tasks }
            return GlanceEntry(date: now, reachability: .live, snapshot: Self.ordered(snapshot, now: now), tasks: tasks ?? GlanceStore.cachedTasks, unreachableSince: nil)
        }
        // Unreachable: keep the last good snapshot and say since when.
        let since = GlanceStore.unreachableSince ?? now
        GlanceStore.unreachableSince = since
        let cached = GlanceStore.cachedSnapshot ?? .empty
        return GlanceEntry(date: now, reachability: .unreachable, snapshot: Self.ordered(cached, now: now), tasks: GlanceStore.cachedTasks, unreachableSince: since)
    }

    private static func loadSnapshot(_ fetch: SharedFetch) async -> NeedsYouSnapshot? {
        try? await NeedsYouSnapshot.load(using: fetch)
    }

    private struct TasksEnvelope: Decodable { let tasks: [InFlightTask] }

    private static func loadTasks(_ fetch: SharedFetch) async -> [InFlightTask]? {
        guard let env = try? await fetch.get("/api/tasks", query: ["limit": "5", "type": "repo-task"], as: TasksEnvelope.self) else { return nil }
        return env.tasks.filter { $0.state == "running" || $0.state == "pr_opened" }.prefix(3).map { $0 }
    }

    /// Oldest first, with locally snoozed items (Later) moved to the back.
    static func ordered(_ snapshot: NeedsYouSnapshot, now: Date) -> NeedsYouSnapshot {
        var s = snapshot
        let sorted = s.needsYou.sorted { $0.since < $1.since }
        let snoozes = GlanceStore.snoozedUntil(for: sorted.map(\.id))
        s.needsYou = GlancePolicy.applySnooze(sorted, id: \.id, snoozedUntil: snoozes, now: now)
        s.running = s.running.sorted { $0.since > $1.since }
        return s
    }
}

// MARK: - Fixtures (placeholders + previews)

enum GlanceFixtures {
    static let now = Date.now
    static let web = WatchItem(kind: .local, id: "t-web", title: "claude-code · web", mono: "optio/apps/web", reason: "Waiting on a permission", preview: "Allow Bash(pnpm test)?", since: now.addingTimeInterval(-4 * 60), state: "needs_you", link: DeepLink.local("t-web", compose: true).url.absoluteString)
    static let api = WatchItem(kind: .local, id: "t-api", title: "claude-code · api", mono: "optio/apps/api", reason: "Claude stopped — reply to continue", since: now.addingTimeInterval(-11 * 60), state: "needs_you", link: DeepLink.local("t-api", compose: true).url.absoluteString)
    static let forge = WatchItem(kind: .agent, id: "a-vesper", title: "Vesper", mono: "vesper", reason: "Gone quiet", since: now.addingTimeInterval(-38 * 60), state: "needs_you", link: DeepLink.agent("a-vesper", compose: true).url.absoluteString)
    static let cli = WatchItem(kind: .local, id: "t-cli", title: "codex · cli", mono: "optio/apps/cli", since: now.addingTimeInterval(-23 * 60), state: "working", link: DeepLink.local("t-cli", compose: false).url.absoluteString)
    static let docs = WatchItem(kind: .local, id: "t-docs", title: "claude-code · docs", mono: "optio/docs", since: now.addingTimeInterval(-2 * 60), state: "working", link: DeepLink.local("t-docs", compose: false).url.absoluteString)

    static let tasks = [
        InFlightTask(id: "task-1", title: "fix: login redirect loops on expired PAT", state: "pr_opened", repoBranch: "fix/login-redirect", prNumber: 581, prUrl: "https://github.com/jonwiggins/optio/pull/581", prChecksStatus: "pending", startedAt: now.addingTimeInterval(-52 * 60)),
        InFlightTask(id: "task-2", title: "feat(ios): widgets and controls", state: "running", repoBranch: "feat/ios-widgets", startedAt: now.addingTimeInterval(-12 * 60)),
    ]

    static let waiting = GlanceEntry(date: now, reachability: .live, snapshot: NeedsYouSnapshot(needsYou: [web, api, forge], running: [cli, docs], hostsOnline: 1, hostsTotal: 1, asOf: now), tasks: tasks, unreachableSince: nil)
    static let one = GlanceEntry(date: now, reachability: .live, snapshot: NeedsYouSnapshot(needsYou: [web], running: [cli], hostsOnline: 1, hostsTotal: 1, asOf: now), tasks: tasks, unreachableSince: nil)
    static let quiet = GlanceEntry(date: now, reachability: .live, snapshot: NeedsYouSnapshot(needsYou: [], running: [cli, docs], hostsOnline: 1, hostsTotal: 1, asOf: now), tasks: tasks, unreachableSince: nil)
    static let idle = GlanceEntry(date: now, reachability: .live, snapshot: NeedsYouSnapshot(needsYou: [], running: [], hostsOnline: 1, hostsTotal: 1, asOf: now), tasks: [], unreachableSince: nil)
    static let offline = GlanceEntry(date: now, reachability: .unreachable, snapshot: NeedsYouSnapshot(needsYou: [web], running: [cli], hostsOnline: 0, hostsTotal: 1, asOf: now.addingTimeInterval(-47 * 60)), tasks: tasks, unreachableSince: now.addingTimeInterval(-41 * 60))
    static let stale = GlanceEntry(date: now, reachability: .live, snapshot: NeedsYouSnapshot(needsYou: [web, api], running: [cli], hostsOnline: 1, hostsTotal: 1, asOf: now.addingTimeInterval(-35 * 60)), tasks: tasks, unreachableSince: nil)
    static let signedOut = GlanceEntry.signedOut(at: now)
}
