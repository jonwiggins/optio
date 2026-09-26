import ActivityKit
import Foundation

/// The one Live Activity Optio runs: how many sessions need you and how many are
/// running, and the sessions waiting on you. See docs/design/ios-glanceable-surfaces.md §2a. The content state is the wire
/// contract shared with the API's APNs `liveactivity` payloads
/// (apps/api/src/services/apns-service.ts), so field names must not change casually.
public struct WatchAttributes: ActivityAttributes {
    public typealias ContentState = WatchState

    /// Owner of the Watch; one activity per user.
    public var userId: String
    public var startedAt: Date

    public init(userId: String, startedAt: Date = .now) {
        self.userId = userId
        self.startedAt = startedAt
    }
}

public struct WatchState: Codable, Hashable, Sendable {
    public enum Phase: String, Codable, Hashable, Sendable {
        /// Something needs you; `head` is the oldest such item.
        case waiting
        /// Nothing needs you; `runningCount` things are working.
        case working
        /// Host or API unreachable for more than ~90 s.
        case offline
        /// Final frame before dismissal; `summary` carries the wrap-up line.
        case done
    }

    public var phase: Phase
    /// Oldest item needing you (when `waiting`) or most recent running item (when `working`).
    public var head: WatchItem?
    /// Up to two further rows from `head`'s list, listed under it: the next items needing
    /// you (oldest first) while `waiting`, the next running items (newest first) while
    /// `working`.
    public var others: [WatchItem]
    /// Total number of items needing you, including `head` and beyond `others`.
    public var needsYouCount: Int
    public var runningCount: Int
    /// Session board tiles the Watch cannot derive from its own items (optional, additive):
    /// sessions halted at their prompt / an open PR, enabled recurring definitions, and
    /// persistent agents not archived. Nil on frames from servers that predate them.
    public var waitingCount: Int?
    public var recurringCount: Int?
    public var agentCount: Int?
    public var offlineSince: Date?
    public var summary: String?
    /// Server/app time the state was computed; drives "as of" in the UI and staleness.
    public var asOf: Date

    public init(phase: Phase, head: WatchItem? = nil, others: [WatchItem] = [], needsYouCount: Int = 0, runningCount: Int = 0, waitingCount: Int? = nil, recurringCount: Int? = nil, agentCount: Int? = nil, offlineSince: Date? = nil, summary: String? = nil, asOf: Date = .now) {
        self.phase = phase
        self.head = head
        self.others = others
        self.needsYouCount = needsYouCount
        self.runningCount = runningCount
        self.waitingCount = waitingCount
        self.recurringCount = recurringCount
        self.agentCount = agentCount
        self.offlineSince = offlineSince
        self.summary = summary
        self.asOf = asOf
    }

    public static let quiet = WatchState(phase: .working)

    // MARK: What the Watch lists

    /// The sessions waiting on you that this frame carries, oldest first: the head, then
    /// the others. Empty unless `waiting`.
    public var queue: [WatchItem] {
        guard phase == .waiting else { return [] }
        return (head.map { [$0] } ?? []) + others
    }

    /// The sessions the Watch lists: the queue while `waiting`; with nothing waiting,
    /// the running sessions, newest first.
    public var rows: [WatchItem] {
        switch phase {
        case .waiting, .working: return (head.map { [$0] } ?? []) + others
        case .offline, .done: return []
        }
    }

    /// How many sessions `rows` stands for: those needing you while `waiting`, those
    /// running while `working`. A frame carries three at most.
    public var rowCount: Int {
        switch phase {
        case .waiting: return needsYouCount
        case .working: return runningCount
        case .offline, .done: return 0
        }
    }

    /// Whether the Watch lists sessions rather than showing one in detail with its
    /// buttons: two or more need you, or with none waiting, two or more are running.
    public var listsRows: Bool { rowCount > 1 }

    /// Most rows the Watch lists. Past that it lists one fewer and a "+N more" line: three
    /// rows and the line under the tiles would overflow the lock screen's 160 pt.
    public static let listMax = 3

    /// The rows the Watch lists: all of them when nothing is left out, else the first
    /// `listMax - 1`.
    public var listed: [WatchItem] {
        rowCount > Self.listMax ? Array(rows.prefix(Self.listMax - 1)) : rows
    }

    /// Sessions the list leaves out (the "+N more" line).
    public var unlisted: Int { max(0, rowCount - listed.count) }

    // MARK: Handing a frame to ActivityKit

    /// Past this the system shows the Watch as stale. The app re-sends unchanged content
    /// before then while it is in the foreground (`LiveActivityManager.refreshAfter`).
    public static let staleAfter: TimeInterval = 90

    /// How the system ranks this activity against the user's others.
    public var relevanceScore: Double {
        switch phase {
        case .waiting: return 100
        case .working: return 50
        case .offline: return 20
        case .done: return 0
        }
    }

    /// This state as an activity update, stale after `staleAfter`.
    public func activityContent(at now: Date = .now) -> ActivityContent<WatchState> {
        ActivityContent(state: self, staleDate: now.addingTimeInterval(Self.staleAfter), relevanceScore: relevanceScore)
    }

    // MARK: Acting from the island

    /// The frame right after the user dealt with item `id` from one of the Watch's
    /// buttons (**Later**, **Resume**, **Retry**). The item stops needing you and counts
    /// as running, as `NeedsYouSnapshot.watchState()` and the server's frame count it,
    /// so the app's next reconcile (or a push) agrees instead of putting it back. The
    /// next oldest item becomes the head. With none left the Watch drops to `working`
    /// with the handled item as its head. `update` rewrites the handled item, for
    /// example its snooze window or a task's new state. Nil when the Watch isn't
    /// asking about `id`.
    public func handling(_ id: String, at now: Date = .now, update: (inout WatchItem) -> Void = { _ in }) -> WatchState? {
        guard phase == .waiting else { return nil }
        var queue = self.queue
        guard let index = queue.firstIndex(where: { $0.id == id }) else { return nil }
        var handled = queue.remove(at: index)
        update(&handled)
        var next = self
        next.asOf = now
        next.runningCount = runningCount + 1
        next.needsYouCount = max(0, needsYouCount - 1)
        if next.needsYouCount > 0, let newHead = queue.first {
            next.head = newHead
            next.others = Array(queue.dropFirst())
        } else {
            next.phase = .working
            next.head = handled
            next.others = []
            next.needsYouCount = 0
        }
        return next
    }
}

// MARK: - Session attributes (v0.5 "one noun: Sessions")

/// Which kind of session a Watch row is (`WorkSource` in the app / web feed).
public enum WatchSessionSource: String, Codable, Hashable, Sendable {
    case repoTask = "repo-task"
    case repoBlueprint = "repo-blueprint"
    case standalone
    case localBlueprint = "local-blueprint"
    case localTerminal = "local-terminal"
    case podSession = "pod-session"
    case persistentAgent = "persistent-agent"
}

/// Where a session runs: an Optio pod (detail = repo / @slug) or the user's machine (detail = host · ~/dir).
public struct WatchWhere: Codable, Hashable, Sendable {
    public enum Target: String, Codable, Hashable, Sendable { case pod, machine }
    public var target: Target
    public var detail: String?

    public init(target: Target, detail: String? = nil) {
        self.target = target
        self.detail = detail
    }

    /// Chip copy: the detail, or the generic place.
    public var label: String { detail ?? (target == .pod ? "Optio pod" : "machine") }
    public var systemImage: String { target == .machine ? "laptopcomputer" : "server.rack" }
}

/// Exit condition: one-shot, halts for the user, or persistent (message-driven).
public enum WatchThen: String, Codable, Hashable, Sendable {
    case exits
    case waitsForMe = "waits-for-me"
    case waitsForMessages = "waits-for-messages"

    public var label: String {
        switch self {
        case .exits: return "exits"
        case .waitsForMe: return "waits for me"
        case .waitsForMessages: return "persistent"
        }
    }

    public var systemImage: String {
        switch self {
        case .exits: return "rectangle.portrait.and.arrow.right"
        case .waitsForMe: return "terminal"
        case .waitsForMessages: return "cpu"
        }
    }
}

/// One row in the Watch (a local terminal, a followed task, or an agent turn).
public struct WatchItem: Codable, Hashable, Sendable, Identifiable {
    public enum Kind: String, Codable, Hashable, Sendable { case local, task, agent }

    public var kind: Kind
    public var id: String
    /// Human title (terminal title, task title, agent name).
    public var title: String
    /// Monospace secondary: dir basename, branch, or agent slug. Truncate head-first.
    public var mono: String
    /// Short reason for attention, e.g. "Waiting on a permission", "Merge conflict".
    public var reason: String?
    /// Last non-empty output line, ≤120 chars; rendered `privacySensitive`.
    public var preview: String?
    /// When the item entered its current state (drives the relative timer).
    public var since: Date
    /// Raw state string (`needs_you`, `running`, `pr_opened`, …) for icon/color mapping.
    public var state: String
    /// Deep link, e.g. `optio://local/<id>?compose=1`.
    public var link: String
    /// Pull request URL for followed tasks in `pr_opened` (drives the **Open PR** button). Optional, additive.
    public var prUrl: String?
    /// Server-side "Later" (`local_terminals.snoozedUntil`) or the App Group fallback. While
    /// the window is open the Watch counts the item as running and the widgets list it
    /// last. Optional, additive.
    public var snoozedUntil: Date?
    /// Which paired server this item lives on (`ServerProfile.id`) and its short name,
    /// so surfaces that merge several servers can label and route it. Optional, additive.
    public var serverId: String?
    public var serverName: String?
    // ── Session attributes (optional, additive; the four chips of a session row) ──
    public var source: WatchSessionSource?
    /// What starts it: "now", "on a trigger", "messages", a spawn source…
    public var when: String?
    public var `where`: WatchWhere?
    /// Runtime id (`claude-code`, `codex`, …) or `terminal`.
    public var who: String?
    public var then: WatchThen?
    /// The session row's status word ("needs you", "working", "PR open", …).
    public var statusLabel: String?

    public init(kind: Kind, id: String, title: String, mono: String, reason: String? = nil, preview: String? = nil, since: Date, state: String, link: String, prUrl: String? = nil, snoozedUntil: Date? = nil, serverId: String? = nil, serverName: String? = nil,
                source: WatchSessionSource? = nil, when: String? = nil, where: WatchWhere? = nil, who: String? = nil, then: WatchThen? = nil, statusLabel: String? = nil) {
        self.kind = kind
        self.id = id
        self.title = title
        self.mono = mono
        self.reason = reason
        self.preview = preview.map { String($0.prefix(120)) }
        self.since = since
        self.state = state
        self.link = link
        self.prUrl = prUrl
        self.snoozedUntil = snoozedUntil
        self.serverId = serverId
        self.serverName = serverName
        self.source = source
        self.when = when
        self.where = `where`
        self.who = who
        self.then = then
        self.statusLabel = statusLabel
    }

    // MARK: Session chips with fallbacks for rows from older servers

    /// When chip: the wire value, else derived from the kind.
    public var whenLabel: String {
        if let when, !when.isEmpty { return when }
        switch kind {
        case .agent: return "messages"
        case .task, .local: return "now"
        }
    }

    public var whenSystemImage: String {
        switch whenLabel {
        case "now": return "play"
        case "messages": return "cpu"
        default: return "clock"
        }
    }

    /// Where chip: the wire value, else the mono secondary (dir / branch / slug).
    public var whereValue: WatchWhere {
        if let w = `where` { return w }
        switch kind {
        case .local: return WatchWhere(target: .machine, detail: mono.isEmpty ? nil : mono)
        case .task, .agent: return WatchWhere(target: .pod, detail: mono.isEmpty ? nil : mono)
        }
    }

    /// Who chip: the wire runtime, else the agent named in a default terminal title.
    public var whoValue: String {
        if let who, !who.isEmpty { return who }
        let parts = title.components(separatedBy: " · ")
        if kind == .local, parts.count > 1, let first = parts.first { return first }
        return kind == .local ? "terminal" : "claude-code"
    }

    public var whoIsTerminal: Bool { whoValue == "terminal" }
    public var whoSystemImage: String { whoIsTerminal ? "terminal" : "bolt" }

    /// Then chip: the wire value, else derived from the kind.
    public var thenValue: WatchThen {
        if let then { return then }
        switch kind {
        case .task: return .exits
        case .agent: return .waitsForMessages
        case .local: return .waitsForMe
        }
    }

    /// Status word: the wire label, else a humanised raw state.
    public var statusText: String {
        if let statusLabel, !statusLabel.isEmpty { return statusLabel }
        switch state {
        case "needs_you": return "needs you"
        case "needs_attention": return "needs attention"
        case "pr_opened": return "PR open"
        default: return state.replacingOccurrences(of: "_", with: " ")
        }
    }

    /// True while a "Later" window is open.
    public func isSnoozed(at now: Date = .now) -> Bool {
        guard let snoozedUntil else { return false }
        return snoozedUntil > now
    }

    /// Status word on the Watch's head row: "later" while a Later window is open (the
    /// item sits in the running count until it closes), otherwise `statusText`.
    public func watchStatusText(at now: Date = .now) -> String {
        isSnoozed(at: now) ? "later" : statusText
    }
}
