import SwiftUI

// Design tokens for the iOS app. See docs/design/ios-ui-review.md §2.
//
// The palette is deliberately small: near-black type on flat grouped surfaces,
// purple reserved for "needs you", semantic colour only for terminal outcomes.
// Blue / orange / yellow / gray / teal literals do not exist in the app; every
// state goes through `Tone.forState(_:)`.

/// The five tones a piece of UI can carry. `accent` is the only one that may
/// draw attention on a resting screen.
enum Tone: Hashable {
    /// #6d28d9 — "needs you": attention badges, the needs-you count, composer send, selected tab.
    case accent
    /// Failed, error, destructive.
    case danger
    /// Completed, merged, healthy, CI passing. Text only, never a fill.
    case success
    /// Running / provisioning / active / online.
    case working
    /// Queued / pending / idle / exited / archived.
    case idle
    /// Skeletons and disabled.
    case muted

    /// Concrete colour for dots, tints and chart fills.
    var color: Color {
        switch self {
        case .accent: return AppTheme.accent
        case .danger: return .red
        case .success: return .green
        case .working: return .secondary
        case .idle: return Color(.tertiaryLabel)
        case .muted: return Color(.quaternaryLabel)
        }
    }

    /// Text style: `.secondary` / `.tertiary` keep their vibrancy on materials.
    var textStyle: AnyShapeStyle {
        switch self {
        case .accent: return AnyShapeStyle(AppTheme.accent)
        case .danger: return AnyShapeStyle(.red)
        case .success: return AnyShapeStyle(.green)
        case .working: return AnyShapeStyle(.secondary)
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

enum Radius {
    /// Badge-shaped rects, icon tiles.
    static let small: CGFloat = 8
    /// All cards, tiles, code blocks.
    static let card: CGFloat = 12
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
