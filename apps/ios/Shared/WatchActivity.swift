import ActivityKit
import Foundation

/// The one Live Activity Optio runs: "the thing waiting on you, plus how many more".
/// See docs/design/ios-glanceable-surfaces.md §2a. The content state is the wire
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
    /// Up to two further items needing you (lock-screen list); the island only shows `head`.
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
}

// MARK: - Session attributes (v0.5 "one noun: Sessions")

/// Which kind of session a Watch row is (`SessionSource` in the app / web feed).
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
    /// Server-side "Later" (`local_terminals.snoozedUntil`) or the App Group fallback; snoozed
    /// items sort after unsnoozed ones while the window is open. Optional, additive.
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
}
