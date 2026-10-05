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

/// Optio Peek, matching design/brand/mark.svg. Fill with the even-odd rule
/// so the face stays transparent on widgets, sign-in, and the Dynamic Island.
public struct BotGlyph: Shape {
    public init() {}

    public func path(in rect: CGRect) -> Path {
        let s = min(rect.width, rect.height) / 100
        let ox = rect.midX - 50 * s
        let oy = rect.midY - 50 * s
        func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: ox + x * s, y: oy + y * s) }
        var path = Path()
        path.move(to: p(30, 6)); path.addLine(to: p(66, 6)); path.addLine(to: p(94, 34))
        path.addLine(to: p(94, 70)); path.addQuadCurve(to: p(70, 94), control: p(94, 94))
        path.addLine(to: p(30, 94)); path.addQuadCurve(to: p(6, 70), control: p(6, 94))
        path.addLine(to: p(6, 30)); path.addQuadCurve(to: p(30, 6), control: p(6, 6))
        path.closeSubpath()
        // Transparent face inset.
        path.move(to: p(36, 24)); path.addQuadCurve(to: p(24, 36), control: p(24, 24))
        path.addLine(to: p(24, 64)); path.addQuadCurve(to: p(36, 76), control: p(24, 76))
        path.addLine(to: p(64, 76)); path.addQuadCurve(to: p(76, 64), control: p(76, 76))
        path.addLine(to: p(76, 36)); path.addQuadCurve(to: p(64, 24), control: p(76, 24))
        path.closeSubpath()
        // Detached corner.
        path.move(to: p(76, 6)); path.addLine(to: p(82, 6))
        path.addQuadCurve(to: p(94, 18), control: p(94, 6)); path.addLine(to: p(94, 24))
        path.addQuadCurve(to: p(92, 24), control: p(94, 26)); path.addLine(to: p(74, 8))
        path.addQuadCurve(to: p(76, 6), control: p(72, 6)); path.closeSubpath()
        for x: CGFloat in [36, 56] {
            path.addRoundedRect(in: CGRect(x: ox + x * s, y: oy + 40 * s, width: 8 * s, height: 20 * s), cornerSize: CGSize(width: 4 * s, height: 4 * s))
        }
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
            .fill(style, style: FillStyle(eoFill: true))
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}
