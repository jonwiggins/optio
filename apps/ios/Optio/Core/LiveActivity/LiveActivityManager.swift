import ActivityKit
import Foundation
import Observation
import OSLog
import UIKit
import WidgetKit

/// Owns the one Watch Live Activity for the signed-in user (brief §2a, architecture §2).
///
/// Sources: Optio Local terminals (via `NeedsYouSnapshot`), followed Repo Tasks
/// (`FollowedTasks`), and Persistent Agent turns the user triggered from this phone in
/// the last hour (`RecentAgentSends`). Wake-ups come from `EventHub`, foreground
/// transitions, BG app refresh windows and a 60 s foreground poll; bursts coalesce
/// over 500 ms. Updates go out only when the content changes (or to refresh
/// `staleDate` while foregrounded). Ends after 2 min of nothing running/waiting with
/// a summary frame, and restarts itself at the 7 h 45 m mark to stay under the 8 h cap.
@MainActor
@Observable
final class LiveActivityManager {
    private let api: APIClient
    private let events: EventHub
    private let session: SessionStore

    /// Whether a Watch is currently live for this user.
    private(set) var isActive = false
    /// Last content state pushed (or that would have been pushed); for a status row.
    private(set) var lastState: WatchState?
    /// `ActivityAuthorizationInfo().areActivitiesEnabled`, refreshed on every reconcile.
    private(set) var activitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
    private(set) var lastError: String?
    private(set) var lastReconcileAt: Date?
    /// Set by the host from `scenePhase`; drives the foreground poll.
    var foreground = false

    private var activity: Activity<WatchAttributes>?
    private var subscription: EventHub.Subscription?
    private var debounce: Task<Void, Never>?
    private var poll: Task<Void, Never>?
    private var quietTimer: Task<Void, Never>?
    private var capTimer: Task<Void, Never>?
    private var tokenTask: Task<Void, Never>?
    private var stateTask: Task<Void, Never>?
    private var pushToStartTask: Task<Void, Never>?
    private var observers: [NSObjectProtocol] = []
    private var started = false
    private var reconciling = false
    private var reconcileAgain = false

    private var lastHash: Int?
    private var lastUpdateAt: Date = .distantPast
    private var quietSince: Date?
    private var firstFailureAt: Date?
    private var pendingIds: Set<String> = []
    private var answered = 0
    private var merged = 0

    static let debounceMs = 500
    static let quietWindow: TimeInterval = 2 * 60
    static let staleAfter: TimeInterval = 90
    static let offlineAfter: TimeInterval = 90
    static let restartAfter: TimeInterval = 7 * 3600 + 45 * 60
    static let dismissAfter: TimeInterval = 15 * 60
    static let foregroundPoll: TimeInterval = 30
    /// Re-send unchanged content this long after the last update so `staleDate` (90 s) never
    /// lapses while the app is foregrounded and polling.
    static let refreshAfter: TimeInterval = 45

    init(api: APIClient, events: EventHub, session: SessionStore) {
        self.api = api
        self.events = events
        self.session = session
    }

    // MARK: - Lifecycle

    func start() {
        guard !started else { return }
        started = true
        subscription = events.subscribe { [weak self] event in self?.handle(event) }
        AppRefresh.handlers.append { [weak self] in await self?.reconcile() }
        for name in [FollowedTasks.changed, RecentAgentSends.changed, UserDefaults.didChangeNotification] {
            observers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] _ in
                Task { @MainActor in self?.reconcileSoon() }
            })
        }
        adoptExistingActivities()
        observePushToStartTokens()
        poll = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.foregroundPoll))
                guard let self, self.foreground else { continue }
                await self.reconcile()
            }
        }
        reconcileSoon()
    }

    /// Sign-out: the Watch belongs to the user, so it goes immediately.
    func stop() {
        started = false
        subscription = nil
        for o in observers { NotificationCenter.default.removeObserver(o) }
        observers.removeAll()
        for t in [debounce, poll, quietTimer, capTimer, tokenTask, stateTask, pushToStartTask] { t?.cancel() }
        if let activity {
            Task { await activity.end(nil, dismissalPolicy: .immediate) }
        }
        detach()
    }

    /// Coalesced recompute (500 ms), for events and UI actions.
    func reconcileSoon() {
        debounce?.cancel()
        debounce = Task { [weak self] in
            try? await Task.sleep(for: .milliseconds(Self.debounceMs))
            guard !Task.isCancelled else { return }
            await self?.reconcile()
        }
    }

    /// Recompute the Watch from the API and apply it. Re-entrant calls queue one more pass.
    func reconcile() async {
        if reconciling { reconcileAgain = true; return }
        reconciling = true
        defer { reconciling = false }
        repeat {
            reconcileAgain = false
            await computeAndApply()
        } while reconcileAgain
    }

    // MARK: - Events

    private func handle(_ event: WsEvent) {
        switch event {
        case .taskStateChanged(let e):
            guard FollowedTasks.contains(e.taskId) else { return }
            switch e.toState {
            case .completed:
                if activity != nil { merged += 1 }
                FollowedTasks.remove(e.taskId)
            case .cancelled:
                FollowedTasks.remove(e.taskId)
            default: break
            }
            reconcileSoon()
        case .taskStalled(let e):
            if FollowedTasks.contains(e.taskId) { reconcileSoon() }
        case .taskRecovered(let e):
            if FollowedTasks.contains(e.taskId) { reconcileSoon() }
        case .persistentAgentTurnStarted(let e):
            if RecentAgentSends.isRecent(e.agentId) { reconcileSoon() }
        case .persistentAgentTurnHalted(let e):
            if RecentAgentSends.isRecent(e.agentId) { reconcileSoon() }
        case .persistentAgentStateChanged(let e):
            if RecentAgentSends.isRecent(e.agentId) { reconcileSoon() }
        case .unknown(let payload):
            if case .object(let o) = payload, case .string(let type)? = o["type"], type.hasPrefix("local:") {
                reconcileSoon()
            }
        default:
            break
        }
    }

    // MARK: - Compute

    private struct AgentEnvelope: Decodable {
        struct Agent: Decodable {
            let id: String; let name: String; let slug: String; let state: String
            let agentRuntime: String?
            let lastTurnAt: Date?; let lastFailureReason: String?
        }
        let agent: Agent
    }

    private func computeAndApply() async {
        lastReconcileAt = .now
        activitiesEnabled = ActivityAuthorizationInfo().areActivitiesEnabled
        #if DEBUG
        if let injected = Self.debugState() {
            await apply(injected)
            return
        }
        #endif
        // Every paired server feeds the one Watch; items carry their server so the
        // island can label them and buttons/links land on the right instance.
        let clients = SharedFetch.allServers
        guard !clients.isEmpty else { return }
        let now = Date()
        let followed = FollowedTasks.all
        var snapshot: NeedsYouSnapshot
        do {
            snapshot = try await NeedsYouSnapshot.loadAll(followed: followed).snapshot
            firstFailureAt = nil
            lastError = nil
        } catch {
            lastError = error.localizedDescription
            let since = firstFailureAt ?? now
            firstFailureAt = since
            // Under 90 s of failure: keep the last frame (it goes stale on its own).
            guard now.timeIntervalSince(since) >= Self.offlineAfter else { return }
            await apply(WatchState(phase: .offline, head: lastState?.head, needsYouCount: lastState?.needsYouCount ?? 0,
                                   runningCount: lastState?.runningCount ?? 0, offlineSince: since, asOf: now))
            return
        }

        // Followed tasks that fell out of the snapshot are finished (or gone): unfollow.
        let present = Set((snapshot.needsYou + snapshot.running).filter { $0.kind == .task }.map(\.id))
        for id in followed.subtracting(present) {
            await confirmUnfollow(id, using: clients)
        }

        // Persistent-agent turns triggered from this phone in the last hour. Agent ids
        // are UUIDs, so the first server that knows one owns it.
        for (agentId, _) in RecentAgentSends.recent(at: now) {
            var found: (AgentEnvelope.Agent, SharedFetch)?
            for c in clients {
                if let row = try? await c.get("/api/persistent-agents/\(agentId)", as: AgentEnvelope.self).agent { found = (row, c); break }
            }
            guard let (row, fetch) = found else { continue }
            let since = row.lastTurnAt ?? now
            let link = DeepLink.agent(row.id, compose: true).url(server: fetch.serverId).absoluteString
            // The same four chips as the app's session row: When = messages, Where = pod @slug,
            // Who = the runtime, Then = persistent.
            func item(title: String, reason: String? = nil, statusLabel: String) -> WatchItem {
                WatchItem(kind: .agent, id: row.id, title: title, mono: "@\(row.slug)", reason: reason,
                          since: since, state: row.state, link: link, serverId: fetch.serverId, serverName: fetch.serverName,
                          source: .persistentAgent, when: "messages", where: WatchWhere(target: .pod, detail: "@\(row.slug)"),
                          who: row.agentRuntime ?? "claude-code", then: .waitsForMessages, statusLabel: statusLabel)
            }
            switch row.state {
            case "running", "queued", "provisioning":
                snapshot.running.append(item(title: row.name, statusLabel: row.state == "running" ? "thinking" : row.state))
            case "failed":
                snapshot.needsYou.append(item(title: row.name, reason: row.lastFailureReason.map { String($0.prefix(80)) } ?? "Turn failed — resume?", statusLabel: "failed"))
            default: break
            }
        }

        // "Later" pressed on the island/widget before the server learned about it.
        snapshot.needsYou = snapshot.needsYou.map { item in
            var item = item
            if item.snoozedUntil == nil, let until = LocalSnoozes.until(item.id), until > now { item.snoozedUntil = until }
            return item
        }
        snapshot.asOf = now

        // "Answered" = items that left the needs-you set while the Watch was live.
        let current = Set(snapshot.needsYou.map(\.id))
        if activity != nil { answered += pendingIds.subtracting(current).count }
        pendingIds = current

        await apply(snapshot.watchState())
    }

    /// Unfollows once every paired server agrees the task is finished or unknown; a
    /// transient failure on any server keeps the follow (a 404 on the wrong laptop is
    /// not proof the task is gone).
    private func confirmUnfollow(_ id: String, using clients: [SharedFetch]) async {
        struct Lite: Decodable { let state: String; let retryCount: Int?; let maxRetries: Int? }
        struct Env: Decodable { let task: Lite }
        for fetch in clients {
            do {
                let t = try await fetch.get("/api/tasks/\(id)", as: Env.self).task
                let finalFailure = t.state == "failed" && (t.retryCount ?? 0) >= (t.maxRetries ?? 0)
                guard t.state == "completed" || t.state == "cancelled" || finalFailure else { return }
            } catch let e as SharedFetch.Failure where e.status == 404 {
                continue
            } catch {
                return // Transient: keep following.
            }
        }
        FollowedTasks.remove(id)
    }

    // MARK: - Apply

    private func apply(_ state: WatchState) async {
        let now = Date()
        lastState = state
        let hasWork = state.phase == .waiting || (state.phase == .working && state.runningCount > 0)
        if hasWork { quietSince = nil } else if quietSince == nil { quietSince = now }

        guard let activity else {
            log.notice("no activity; phase=\(state.phase.rawValue, privacy: .public) needsYou=\(state.needsYouCount) running=\(state.runningCount) enabled=\(self.activitiesEnabled)")
            guard hasWork, activitiesEnabled else { return }
            await request(state)
            return
        }

        // 8 h cap: end at 7 h 45 m and re-request immediately if still live.
        if now.timeIntervalSince(activity.attributes.startedAt) >= Self.restartAfter {
            await activity.end(nil, dismissalPolicy: .immediate)
            detach()
            if hasWork { await request(state) }
            return
        }

        if !hasWork, let quiet = quietSince, now.timeIntervalSince(quiet) >= Self.quietWindow {
            await endWithSummary(activity, at: now)
            return
        }
        if !hasWork { scheduleQuietTimer() }

        let hash = Self.contentHash(state)
        let refreshStale = now.timeIntervalSince(lastUpdateAt) >= Self.refreshAfter
        guard hash != lastHash || refreshStale else { return }
        let alert: AlertConfiguration? = (state.phase == .waiting && lastHashPhase != .waiting)
            ? AlertConfiguration(title: "A session needs you", body: LocalizedStringResource(stringLiteral: alertBody(state)), sound: .default) : nil
        await activity.update(content(state, at: now), alertConfiguration: alert)
        log.notice("updated \(activity.id, privacy: .public) phase=\(state.phase.rawValue, privacy: .public) needsYou=\(state.needsYouCount) running=\(state.runningCount) alert=\(alert != nil)")
        lastHash = hash
        lastHashPhase = state.phase
        lastUpdateAt = now
    }

    private var lastHashPhase: WatchState.Phase?
    private let log = Logger(subsystem: "dev.optio.ios", category: "live-activity")

    private func request(_ state: WatchState) async {
        guard let userId = session.user?.id else { return }
        let now = Date()
        let attributes = WatchAttributes(userId: userId, startedAt: now)
        let content = content(state, at: now)
        do {
            let a: Activity<WatchAttributes>
            if Self.pushCapable {
                do {
                    a = try Activity.request(attributes: attributes, content: content, pushType: .token)
                } catch {
                    a = try Activity.request(attributes: attributes, content: content, pushType: nil)
                }
            } else {
                a = try Activity.request(attributes: attributes, content: content, pushType: nil)
            }
            attach(a)
            log.notice("requested \(a.id, privacy: .public) phase=\(state.phase.rawValue, privacy: .public) push=\(Self.pushCapable)")
            lastHash = Self.contentHash(state)
            lastHashPhase = state.phase
            lastUpdateAt = now
            answered = 0
            merged = 0
            lastError = nil
        } catch {
            // Disabled in Settings, too many activities, or unsupported: stay quiet.
            lastError = error.localizedDescription
            log.error("request failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private func endWithSummary(_ activity: Activity<WatchAttributes>, at now: Date) async {
        let summary = "Sessions ended. \(answered) answered, \(merged) PR\(merged == 1 ? "" : "s") merged."
        let done = WatchState(phase: .done, summary: summary, asOf: now)
        await activity.end(ActivityContent(state: done, staleDate: nil, relevanceScore: 0),
                           dismissalPolicy: .after(now.addingTimeInterval(Self.dismissAfter)))
        lastState = done
        log.notice("ended with summary: \(summary, privacy: .public)")
        detach()
    }

    private func content(_ state: WatchState, at now: Date) -> ActivityContent<WatchState> {
        let relevance: Double = switch state.phase {
        case .waiting: 100
        case .working: 50
        case .offline: 20
        case .done: 0
        }
        return ActivityContent(state: state, staleDate: now.addingTimeInterval(Self.staleAfter), relevanceScore: relevance)
    }

    private func alertBody(_ state: WatchState) -> String {
        guard let head = state.head else { return "A session needs you" }
        return "\(head.title) · \(head.reason ?? head.statusText)"
    }

    /// Hash of everything that changes what the user sees (not `asOf`).
    static func contentHash(_ state: WatchState) -> Int {
        var s = state
        s.asOf = .distantPast
        return s.hashValue
    }

    private func scheduleQuietTimer() {
        guard quietTimer == nil || quietTimer?.isCancelled == true else { return }
        quietTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(Self.quietWindow + 1))
            guard !Task.isCancelled else { return }
            self?.quietTimer = nil
            await self?.reconcile()
        }
    }

    // MARK: - Activity bookkeeping

    private func adoptExistingActivities() {
        let existing = Activity<WatchAttributes>.activities
        let mine = existing.first { $0.attributes.userId == session.user?.id } ?? existing.first
        for a in existing where a.id != mine?.id {
            Task { await a.end(nil, dismissalPolicy: .immediate) }
        }
        if let mine {
            // Seed change detection from the live content so adoption never re-alerts.
            let state = mine.content.state
            lastHash = Self.contentHash(state)
            lastHashPhase = state.phase
            lastState = state
            lastUpdateAt = .now
            pendingIds = state.phase == .waiting ? Set(([state.head] + state.others).compactMap { $0 }.map(\.id)) : []
            attach(mine)
        }
    }

    private func attach(_ a: Activity<WatchAttributes>) {
        activity = a
        isActive = true
        quietSince = nil
        quietTimer?.cancel(); quietTimer = nil
        observePushTokens(a)
        stateTask?.cancel()
        stateTask = Task { [weak self] in
            for await s in a.activityStateUpdates {
                if s == .dismissed || s == .ended {
                    await MainActor.run { if self?.activity?.id == a.id { self?.detach() } }
                }
            }
        }
        capTimer?.cancel()
        let remaining = Self.restartAfter - Date().timeIntervalSince(a.attributes.startedAt)
        capTimer = Task { [weak self] in
            try? await Task.sleep(for: .seconds(max(1, remaining)))
            guard !Task.isCancelled else { return }
            await self?.reconcile()
        }
    }

    private func detach() {
        activity = nil
        isActive = false
        lastHash = nil
        lastHashPhase = nil
        pendingIds = []
        tokenTask?.cancel(); tokenTask = nil
        stateTask?.cancel(); stateTask = nil
        capTimer?.cancel(); capTimer = nil
    }

    // MARK: - Push tokens (no-ops without `aps-environment`; errors are swallowed)

    /// True when the embedded provisioning profile carries `aps-environment`, or on the
    /// simulator (Xcode 16+ simulators issue ActivityKit tokens and accept `simctl push`).
    static let pushCapable: Bool = {
        #if targetEnvironment(simulator)
        return true
        #else
        guard let path = Bundle.main.path(forResource: "embedded", ofType: "mobileprovision"),
              let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let text = String(data: data, encoding: .isoLatin1) else { return false }
        return text.contains("aps-environment")
        #endif
    }()

    static let pushEnvironment: String = {
        #if DEBUG
        return "sandbox"
        #else
        return "production"
        #endif
    }()

    private func observePushTokens(_ a: Activity<WatchAttributes>) {
        guard Self.pushCapable else { return }
        tokenTask?.cancel()
        tokenTask = Task { [weak self] in
            for await data in a.pushTokenUpdates {
                await self?.register(token: data, path: "/api/notifications/live-activities/watch/token")
            }
        }
    }

    private func observePushToStartTokens() {
        guard Self.pushCapable, #available(iOS 17.2, *) else { return }
        pushToStartTask?.cancel()
        pushToStartTask = Task { [weak self] in
            for await data in Activity<WatchAttributes>.pushToStartTokenUpdates {
                await self?.register(token: data, path: "/api/notifications/live-activities/watch/push-to-start")
            }
        }
    }

    private func register(token: Data, path: String) async {
        struct Body: Encodable { let token: String; let environment: String }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        log.notice("push token for \(path, privacy: .public): \(hex.prefix(12), privacy: .public)…")
        // The backend routes may not exist yet (404) or the tailnet may be down: quiet either way.
        try? await api.post(path, body: Body(token: hex, environment: Self.pushEnvironment))
    }

    // MARK: - DEBUG hook

    #if DEBUG
    /// `SIMCTL_CHILD_OPTIO_DEV_LA_STATE='{"phase":"waiting",...}'` drives the content state
    /// directly for screenshots. Dates are Apple reference-date seconds (ActivityKit default), like the APNs payloads.
    static func debugState() -> WatchState? {
        guard let raw = ProcessInfo.processInfo.environment["OPTIO_DEV_LA_STATE"], let data = raw.data(using: .utf8) else { return nil }
        let d = JSONDecoder()
        return try? d.decode(WatchState.self, from: data)
    }
    #endif
}
