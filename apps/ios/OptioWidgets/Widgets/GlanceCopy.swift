import Foundation

/// Pure copy and layout decisions for the Sessions surfaces (widgets, Live Activity,
/// controls). Foundation-only like `GlancePolicy`, so `scripts/test-glance-policy.sh`
/// compiles and checks it with bare `swiftc`. Everything here takes plain counts and
/// strings; the views map `WatchState` / `GlanceEntry` onto these.
enum GlanceCopy {
    // MARK: Counts

    /// "2 need you · 3 running" / "3 running" / "Quiet". The lock-screen counts line
    /// and the widget header. `needsYou` excludes the head when `excludingHead` is set
    /// ("2 more need you · 3 running" under a head row).
    static func countsLine(needsYou: Int, running: Int, excludingHead: Bool = false) -> String {
        var parts: [String] = []
        let more = excludingHead ? max(0, needsYou - 1) : needsYou
        if more > 0 {
            let noun = excludingHead ? "more need\(more == 1 ? "s" : "") you" : (more == 1 ? "needs you" : "need you")
            parts.append("\(more) \(noun)")
        }
        if running > 0 { parts.append("\(running) running") }
        if parts.isEmpty { return excludingHead ? "" : "Quiet" }
        return parts.joined(separator: " · ")
    }

    /// The one number a small surface shows, and its noun: needs-you when non-zero,
    /// else running, else nothing (`nil` → the surface says "Quiet").
    static func headlineCount(needsYou: Int, running: Int) -> (count: Int, noun: String)? {
        if needsYou > 0 { return (needsYou, needsYou == 1 ? "needs you" : "need you") }
        if running > 0 { return (running, "running") }
        return nil
    }

    /// Live Activity headline per phase, in session vocabulary.
    static func headline(phase: String, needsYou: Int, running: Int) -> String {
        switch phase {
        case "waiting": return needsYou == 1 ? "1 session needs you" : "\(needsYou) sessions need you"
        case "working": return running == 0 ? "Nothing needs you" : "Nothing needs you · \(running) running"
        case "offline": return "Machine unreachable"
        default: return "Sessions ended"
        }
    }

    /// Compact-trailing text on the island: "+2" beside the head's mono while waiting,
    /// the running count while working. Empty when there is nothing to add.
    static func compactTrailing(phase: String, needsYou: Int, running: Int) -> String {
        switch phase {
        case "waiting": return needsYou > 1 ? "+\(needsYou - 1)" : ""
        case "working": return running > 0 ? "\(running)" : ""
        case "offline": return "offline"
        default: return ""
        }
    }

    /// Working-phase secondary line: "3 sessions running" / "quiet".
    static func workingLine(running: Int) -> String {
        switch running {
        case 0: return "quiet"
        case 1: return "1 session running"
        default: return "\(running) sessions running"
        }
    }

    /// Inline accessory: "Optio · web Allow? +2" / "Optio · 3 running" / "Optio · quiet".
    static func inline(prefix: String, headName: String?, headWord: String?, needsYou: Int, running: Int) -> String {
        if let headName, needsYou > 0 {
            let word = headWord ?? "needs you"
            return needsYou > 1 ? "\(prefix) · \(headName) \(word) +\(needsYou - 1)" : "\(prefix) · \(headName) \(word)"
        }
        if running > 0 { return "\(prefix) · \(running) running" }
        return "\(prefix) · quiet"
    }

    // MARK: Board tiles

    /// One tile of the session board (`Need you / Running / Waiting for you / Recurring / Agents`).
    struct Tile: Equatable {
        enum Id: String, CaseIterable { case needsYou, running, waiting, recurring, agents }
        let id: Id
        let label: String
        let count: Int
        /// The Sessions view the tile opens (`optio://section/sessions?view=…`).
        var view: String {
            switch id {
            case .needsYou, .running, .waiting: return "active"
            case .recurring: return "recurring"
            case .agents: return "agents"
            }
        }
    }

    /// The tiles a widget can show: always Need you and Running (from the rows it has);
    /// the other three only when the server supplied them (`counts` non-nil), so an older
    /// server renders two honest tiles instead of three blanks.
    static func tiles(needsYou: Int, running: Int, waiting: Int?, recurring: Int?, agents: Int?) -> [Tile] {
        var out = [
            Tile(id: .needsYou, label: "Need you", count: needsYou),
            Tile(id: .running, label: "Running", count: running),
        ]
        if let waiting { out.append(Tile(id: .waiting, label: "Waiting", count: waiting)) }
        if let recurring { out.append(Tile(id: .recurring, label: "Recurring", count: recurring)) }
        if let agents { out.append(Tile(id: .agents, label: "Agents", count: agents)) }
        return out
    }

    // MARK: Chips

    /// Who chip copy: runtime ids → short labels, `terminal` as is.
    static func whoLabel(_ who: String) -> String {
        switch who {
        case "terminal": return "terminal"
        case "claude-code": return "Claude Code"
        case "codex": return "Codex"
        case "copilot": return "Copilot"
        case "gemini": return "Gemini"
        case "opencode": return "OpenCode"
        case "cursor": return "Cursor"
        default: return who
        }
    }

    /// Where chip copy trimmed for a widget row: keep the leaf of a path and the host.
    /// "MacBook Pro · ~/repos/optio/apps/web" → "MacBook Pro · web" when `short`.
    static func whereLabel(_ detail: String?, target: String, short: Bool) -> String {
        guard let detail, !detail.isEmpty else { return target == "pod" ? "Optio pod" : "machine" }
        guard short else { return detail }
        let parts = detail.components(separatedBy: " · ")
        guard let last = parts.last else { return detail }
        let leaf = last.split(separator: "/").last.map(String.init) ?? last
        if parts.count > 1 { return "\(parts[0]) · \(leaf)" }
        return leaf
    }
}
