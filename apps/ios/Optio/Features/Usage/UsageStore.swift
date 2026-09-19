import Foundation
import Observation
import SwiftUI

/// The one poller behind every usage surface — the Overview's limits panel,
/// the pill on session headers, and the breakdown sheet — so the numbers are
/// fetched once and shared (`useAccountUsage` in `usage-chips.tsx`). Holds
/// Claude's live account usage (`/api/auth/usage`) and the paired hosts (for
/// the Codex snapshot the daemon reads off the machine). Refreshes when a
/// viewer appears, every 60 s while any view observes it, and on foreground.
@Observable
@MainActor
final class UsageStore {
    static let pollInterval: Duration = .seconds(60)
    /// A viewer appearing within this window reuses the cached numbers.
    static let staleAfter: TimeInterval = 30
    /// Manual refreshes bypass the server cache — and hit Anthropic — so pace them.
    static let freshMinGap: TimeInterval = 15

    private(set) var usage: ClaudeUsageData?
    private(set) var hosts: [LocalHost] = []
    private(set) var lastFetched: Date?
    /// A manual ("fresh") refresh is in flight.
    private(set) var refreshing = false
    /// When the last manual refresh landed, for "updated just now".
    private(set) var refreshedAt: Date?
    private(set) var refreshError: String?

    private var api: APIClient?
    private var inFlight: Task<Void, Never>?
    private var viewers = 0
    private var lastFreshAt: Date?

    /// Point the store at the active server's client. A different client (server
    /// switch) drops the cache so the other server's numbers never show.
    func bind(api: APIClient) {
        guard api !== self.api else { return }
        self.api = api
        usage = nil
        hosts = []
        lastFetched = nil
        refreshedAt = nil
        refreshError = nil
    }

    // MARK: Derived

    /// Both providers, in panel order (Claude, Codex).
    var providerLimits: [ProviderLimits] {
        UsageLimits.collectProviderLimits(usage: usage, hosts: hosts)
    }

    /// Claude's header buckets (5h · 7d · 7d <Model>); empty hides the pill.
    var claudeBuckets: [ProviderLimits.Window] {
        guard let usage, usage.available else { return [] }
        return UsageLimits.claudeBuckets(usage)
    }

    // MARK: Fetching

    /// Refetch unless the cache is younger than `staleAfter`.
    func refreshIfStale() async {
        if let lastFetched, Date.now.timeIntervalSince(lastFetched) < Self.staleAfter { return }
        await refresh()
    }

    /// One shared fetch; concurrent callers await the same request.
    func refresh(fresh: Bool = false) async {
        if let inFlight { return await inFlight.value }
        let task = Task { await load(fresh: fresh) }
        inFlight = task
        await task.value
        inFlight = nil
    }

    /// Re-read from Anthropic now (rate-paced). Returns false when paced out.
    @discardableResult
    func refreshFresh() async -> Bool {
        if let lastFreshAt, Date.now.timeIntervalSince(lastFreshAt) < Self.freshMinGap { return false }
        lastFreshAt = .now
        refreshing = true
        refreshError = nil
        let started = Date.now
        await refresh(fresh: true)
        // Anthropic answers fast; hold the spinner ≥400 ms so the tap visibly did something.
        let wait = 0.4 - Date.now.timeIntervalSince(started)
        if wait > 0 { try? await Task.sleep(for: .seconds(wait)) }
        if refreshError == nil { refreshedAt = .now }
        refreshing = false
        return true
    }

    /// Hold the poller open while a view is on screen: refresh on appear, then
    /// every `pollInterval`. Cancel (the view's `.task` ending) releases it.
    func observe() async {
        viewers += 1
        defer { viewers -= 1 }
        while !Task.isCancelled {
            await refreshIfStale()
            try? await Task.sleep(for: Self.pollInterval)
        }
    }

    /// Mirrors `refreshUsage` in the web hook: an unavailable-without-error usage
    /// response (or a failed call) is cross-checked against `/api/auth/status` so
    /// an expired OAuth token surfaces as the token banner.
    private func load(fresh: Bool) async {
        guard let api else { return }
        async let hostsResult = try? api.listLocalHosts()
        do {
            var u = try await api.accountUsage(fresh: fresh)
            if !u.available, u.error == nil, let status = try? await api.dashAuthStatus(), status.subscription?.expired == true {
                u = ClaudeUsageData(available: false, error: "OAuth token has expired")
            }
            usage = u
            if fresh { refreshError = nil }
        } catch {
            if let status = try? await api.dashAuthStatus(), status.subscription?.expired == true {
                usage = ClaudeUsageData(available: false, error: "OAuth token has expired")
            }
            if fresh { refreshError = ErrorText.humanize(error, what: "usage") }
        }
        if let h = await hostsResult { hosts = h }
        lastFetched = .now
    }
}

// MARK: - View plumbing

extension View {
    /// Keep the shared store polling while this view is on screen, and refetch
    /// when the app returns to the foreground.
    func observesUsage() -> some View { modifier(ObservesUsage()) }
}

private struct ObservesUsage: ViewModifier {
    @Environment(UsageStore.self) private var store
    @Environment(APIClient.self) private var api
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .task {
                store.bind(api: api)
                await store.observe()
            }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { Task { await store.refreshIfStale() } }
            }
    }
}
