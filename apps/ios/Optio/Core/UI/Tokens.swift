import SwiftUI

// Design tokens for the iOS app. See docs/design/ios-ui-review.md §2.
//
// The palette is deliberately small: near-black type on flat grouped surfaces and
// one status palette (Shared/StatusColor.swift): purple working, yellow needs
// input, green completed, grey idle, red failed. Every state goes through
// `Tone.forState(_:)`, which mirrors `StatusKind.forState(_:)`.

/// The five tones a piece of UI can carry. `accent` is the only one that may
/// draw attention on a resting screen.
enum Tone: Hashable {
    /// Yellow — "needs you": attention badges and the needs-you count.
    case accent
    /// Failed, error, destructive.
    case danger
    /// Completed, merged, healthy, CI passing. Text only, never a fill.
    case success
    /// Purple — running / provisioning / active / online.
    case working
    /// Queued / pending / idle / exited / archived.
    case idle
    /// Skeletons and disabled.
    case muted

    /// Concrete colour for dots, tints and chart fills. Purple = working, yellow =
    /// needs input, green = completed, grey = idle / dead, red = failed
    /// (Shared/StatusColor.swift, the same palette the widgets and island use).
    var color: Color {
        switch self {
        case .accent: return StatusColor.yellow
        case .danger: return StatusColor.red
        case .success: return StatusColor.green
        case .working: return StatusColor.purple
        case .idle: return StatusColor.grey
        case .muted: return Color(.quaternaryLabel)
        }
    }

    /// Text style: `.tertiary` / `.quaternary` keep their vibrancy on materials.
    var textStyle: AnyShapeStyle {
        switch self {
        case .accent: return AnyShapeStyle(StatusColor.yellow)
        case .danger: return AnyShapeStyle(StatusColor.red)
        case .success: return AnyShapeStyle(StatusColor.green)
        case .working: return AnyShapeStyle(StatusColor.purple)
        case .idle: return AnyShapeStyle(.tertiary)
        case .muted: return AnyShapeStyle(.quaternary)
        }
    }

    /// Whether a list row should show a leading state dot for this tone.
    var showsDot: Bool {
        switch self {
        case .accent, .danger, .working: return true
        case .success, .idle, .muted: return false
        }
    }

    /// The single state → tone map for tasks, jobs, runs, sessions, agents, PR
    /// reviews, local terminals, pods and connections. Unknown states are idle.
    static func forState(_ state: String?) -> Tone {
        switch (state ?? "").lowercased() {
        case "needs_attention", "needs_you", "stalled", "paused", "review_requested", "waiting_for_off_peak",
             "changes_requested", "request_changes", "ready", "attention", "held", "hold":
            return .accent
        case "failed", "error", "closed", "offline", "crashloopbackoff", "imagepullbackoff", "errimagepull",
             "notready", "failing", "unhealthy", "oom_killed", "oomkilled", "crashed", "dead", "evicted":
            return .danger
        case "completed", "merged", "approved", "approve", "success", "succeeded", "healthy", "passing",
             "submitted", "done", "orphan_cleaned", "ready_node", "online_host":
            return .success
        case "running", "active", "online", "working", "provisioning", "launching", "reviewing", "pr_opened",
             "connected", "connecting", "reconnecting", "in_progress", "processing", "live", "open", "restarted":
            return .working
        default:
            return .idle
        }
    }
}

enum Spacing {
    static let xs: CGFloat = 4
    static let s: CGFloat = 8
    static let m: CGFloat = 12
    static let l: CGFloat = 16
    static let xl: CGFloat = 24
    /// Vertical padding inside a list row.
    static let row: CGFloat = 6
}

/// Corner radii. Every rounded rect in the app is `.continuous` (Apple's
/// superellipse corners); use the shape helpers rather than a literal.
enum Radius {
    /// Badge-shaped rects, icon tiles, code chips.
    static let small: CGFloat = 10
    /// Cards on the grouped page: the same radius iOS gives inset-grouped list
    /// sections, so hand-built cards sit flush with native rows (26 on iOS 26, 12 before).
    static let card: CGFloat = {
        if #available(iOS 26, *) { return 26 } else { return 12 }
    }()
    /// A rounded child inset by `Spacing.m` inside a card: concentric with the card corner.
    static let inner: CGFloat = max(card - Spacing.m, small)
    /// Chat bubbles, composer fields, banners that stand alone.
    static let bubble: CGFloat = 18

    static let cardShape = RoundedRectangle(cornerRadius: card, style: .continuous)
    static let smallShape = RoundedRectangle(cornerRadius: small, style: .continuous)
    static let innerShape = RoundedRectangle(cornerRadius: inner, style: .continuous)
    static let bubbleShape = RoundedRectangle(cornerRadius: bubble, style: .continuous)
}

enum Cost {
    /// "$0.78", "$12" — two decimals under $10, none above. Zero and nil → "$0".
    static func format(_ value: Double?) -> String {
        guard let v = value, v.isFinite, v > 0 else { return "$0" }
        if v < 10 { return String(format: "$%.2f", v) }
        return String(format: "$%.0f", v.rounded())
    }

    static func format(_ value: String?) -> String { format(Double(value ?? "")) }

    /// nil when there is nothing worth showing (rows hide zero cost).
    static func formatIfNonZero(_ value: Double?) -> String? {
        guard let v = value, v.isFinite, v > 0 else { return nil }
        return format(v)
    }

    static func formatIfNonZero(_ value: String?) -> String? { formatIfNonZero(Double(value ?? "")) }
}

/// One categorical sequence for Analytics, Costs and Overview charts.
enum ChartPalette {
    static let series: [Color] = [
        AppTheme.accent,
        Color.primary.opacity(0.55),
        Color.primary.opacity(0.3),
        Color.primary.opacity(0.15),
    ]
    static func color(_ index: Int) -> Color { series[index % series.count] }

    static let primaryHeight: CGFloat = 160
    static let secondaryHeight: CGFloat = 96

    /// Fill behind a single-series line.
    static let areaOpacity = 0.12
}

/// Surfaces: the one card colour and the one inset colour.
enum Surface {
    /// Card on a grouped page — what iOS itself does.
    static let card = Color(.secondarySystemGroupedBackground)
    static let page = Color(.systemGroupedBackground)
}

extension Font {
    /// Mono for paths, branches, PR numbers, slugs, cron, JSON, logs — never prose.
    static let monoSubheadline = Font.system(.subheadline, design: .monospaced)
    static let monoFootnote = Font.system(.footnote, design: .monospaced)
    static let monoCaption = Font.system(.caption, design: .monospaced)
    static let statValue = Font.title2.weight(.semibold).monospacedDigit()
    static let sectionHeader = Font.footnote.weight(.semibold)
}
