import SwiftUI

/// The one status palette, shared by the app, the widgets and the Live Activity:
/// purple = working, yellow = needs input, green = completed, grey = dead / idle,
/// red = failed. Every state string goes through `StatusKind.forState(_:)`.
public enum StatusColor {
    /// #6d28d9 — working / running.
    public static let purple = Color(red: 0x6D / 255, green: 0x28 / 255, blue: 0xD9 / 255)
    /// Needs input. Amber in light mode so it survives as text on white; system
    /// yellow in dark mode and on the island.
    public static let yellow = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 1.0, green: 0.84, blue: 0.04, alpha: 1)
            : UIColor(red: 0.80, green: 0.56, blue: 0.0, alpha: 1)
    })
    /// Completed / merged / healthy.
    public static let green = Color(UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(red: 0.19, green: 0.82, blue: 0.35, alpha: 1)
            : UIColor(red: 0.13, green: 0.62, blue: 0.28, alpha: 1)
    })
    /// Dead / exited / idle.
    public static let grey = Color(.tertiaryLabel)
    /// Failed / error.
    public static let red = Color.red
}

/// Coarse state bucket for colour coding across surfaces.
public enum StatusKind: Hashable, Sendable {
    case working, needsInput, completed, failed, dead

    public var color: Color {
        switch self {
        case .working: return StatusColor.purple
        case .needsInput: return StatusColor.yellow
        case .completed: return StatusColor.green
        case .failed: return StatusColor.red
        case .dead: return StatusColor.grey
        }
    }

    public var label: String {
        switch self {
        case .working: return "working"
        case .needsInput: return "needs input"
        case .completed: return "completed"
        case .failed: return "failed"
        case .dead: return "stopped"
        }
    }

    /// The single state → colour map for tasks, jobs, runs, sessions, agents, PR
    /// reviews, local terminals, pods and connections. Unknown states are dead/idle.
    public static func forState(_ state: String?) -> StatusKind {
        switch (state ?? "").lowercased() {
        case "needs_attention", "needs_you", "stalled", "paused", "review_requested", "waiting_for_off_peak",
             "changes_requested", "request_changes", "ready", "attention", "held", "hold":
            return .needsInput
        case "failed", "error", "closed", "offline", "crashloopbackoff", "imagepullbackoff", "errimagepull",
             "notready", "failing", "unhealthy", "oom_killed", "oomkilled", "crashed", "dead", "evicted":
            return .failed
        case "completed", "merged", "approved", "approve", "success", "succeeded", "healthy", "passing",
             "submitted", "done", "orphan_cleaned", "ready_node", "online_host":
            return .completed
        case "running", "active", "online", "working", "provisioning", "launching", "reviewing", "pr_opened",
             "connected", "connecting", "reconnecting", "in_progress", "processing", "live", "open", "restarted",
             "queued", "pending":
            return .working
        default:
            return .dead
        }
    }
}

/// The Optio bot: antenna, head, ears, eyes — the same mark as the app icon, drawn
/// as a stroke so it can take any colour. 24-unit grid, centred in `rect`.
public struct BotGlyph: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 24
        let ox = rect.midX - 12 * s
        let oy = rect.midY - 12 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        // antenna
        path.move(to: p(12, 8)); path.addLine(to: p(12, 4)); path.addLine(to: p(8, 4))
        // head
        path.addRoundedRect(in: CGRect(x: ox + 4 * s, y: oy + 8 * s, width: 16 * s, height: 12 * s), cornerSize: CGSize(width: 2.4 * s, height: 2.4 * s))
        // ears
        path.move(to: p(2, 14)); path.addLine(to: p(4, 14))
        path.move(to: p(20, 14)); path.addLine(to: p(22, 14))
        // eyes
        path.move(to: p(15, 13)); path.addLine(to: p(15, 15))
        path.move(to: p(9, 13)); path.addLine(to: p(9, 15))
        return path
    }
}

/// The bot glyph at a point size, in a colour. Replaces the SF Symbol terminal
/// icon in widgets and the Dynamic Island so every Optio surface wears the same mark.
public struct OptioGlyph: View {
    public var size: CGFloat
    public var style: AnyShapeStyle

    public init(size: CGFloat = 16, style: some ShapeStyle = Color.secondary) {
        self.size = size
        self.style = AnyShapeStyle(style)
    }

    public var body: some View {
        BotGlyph()
            .stroke(style, style: StrokeStyle(lineWidth: max(1.5, size / 9), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
