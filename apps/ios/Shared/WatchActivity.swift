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
    public var offlineSince: Date?
    public var summary: String?
    /// Server/app time the state was computed; drives "as of" in the UI and staleness.
    public var asOf: Date

    public init(phase: Phase, head: WatchItem? = nil, others: [WatchItem] = [], needsYouCount: Int = 0, runningCount: Int = 0, offlineSince: Date? = nil, summary: String? = nil, asOf: Date = .now) {
        self.phase = phase
        self.head = head
        self.others = others
        self.needsYouCount = needsYouCount
        self.runningCount = runningCount
        self.offlineSince = offlineSince
        self.summary = summary
        self.asOf = asOf
    }

    public static let quiet = WatchState(phase: .working)
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

    public init(kind: Kind, id: String, title: String, mono: String, reason: String? = nil, preview: String? = nil, since: Date, state: String, link: String) {
        self.kind = kind
        self.id = id
        self.title = title
        self.mono = mono
        self.reason = reason
        self.preview = preview.map { String($0.prefix(120)) }
        self.since = since
        self.state = state
        self.link = link
    }
}
