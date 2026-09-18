import SwiftUI
import WidgetKit

/// Visual language from docs/design/ios-glanceable-surfaces.md §3, shared by every widget.
/// Colour is the status palette (Shared/StatusColor.swift): yellow needs input,
/// purple working, green done, grey idle, red failed.
///
/// Widgets are narrow: rows never carry a sentence. Each state maps to one symbol and
/// one word (`RowBadge`), names are the leaf of a path, and waits are "4m", not
/// "4 min. ago".
enum GlanceStyle {
    /// Yellow: something needs you.
    static let needsYou = StatusColor.yellow
    /// Purple: agents are working.
    static let working = StatusColor.purple
    /// SF Symbol stand-in for surfaces that only accept symbols (Control Center).
    static let glyph = "apple.terminal"

    /// Header glyph: the bot, yellow when `count` items need you, else grey.
    static func headerGlyph(needsYou count: Int, size: CGFloat = 16) -> some View {
        OptioGlyph(size: size, style: count > 0 ? AnyShapeStyle(needsYou) : AnyShapeStyle(.secondary))
            .widgetAccentable(count > 0)
    }

    static let clock: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()

    static func time(_ date: Date) -> String { clock.string(from: date) }
}

// MARK: - Row vocabulary

/// One symbol and one word for a row's trailing edge. Nil means "just working": the
/// row shows its elapsed time and nothing else.
struct RowBadge: Hashable {
    let symbol: String
    let word: String
    let kind: StatusKind

    var color: Color { kind.color }

    /// Derived from the raw state plus the human reason the server already wrote, so
    /// the wire contract (`WatchItem.reason`) stays untouched.
    static func of(_ item: WatchItem) -> RowBadge? {
        let reason = (item.reason ?? "").lowercased()
        switch item.state.lowercased() {
        case "needs_you":
            if reason.contains("permission") { return RowBadge(symbol: "hand.raised.fill", word: "Allow?", kind: .needsInput) }
            if reason.contains("stopped") || reason.contains("reply") || reason.contains("waiting for you") { return RowBadge(symbol: "bubble.left.fill", word: "Reply", kind: .needsInput) }
            if reason.contains("quiet") { return RowBadge(symbol: "zzz", word: "Quiet", kind: .needsInput) }
            if reason.contains("bell") { return RowBadge(symbol: "bell.fill", word: "Bell", kind: .needsInput) }
            if reason.contains("finished") || reason.contains("review") { return RowBadge(symbol: "checkmark.circle.fill", word: "Review", kind: .needsInput) }
            return RowBadge(symbol: "exclamationmark.bubble.fill", word: "Needs you", kind: .needsInput)
        case "needs_attention":
            if reason.contains("conflict") { return RowBadge(symbol: "arrow.triangle.merge", word: "Conflict", kind: .needsInput) }
            return RowBadge(symbol: "exclamationmark.triangle.fill", word: "Stuck", kind: .needsInput)
        case "failed", "error":
            return RowBadge(symbol: "xmark.circle.fill", word: "Failed", kind: .failed)
        case "pr_opened":
            if reason.contains("failing") { return RowBadge(symbol: "xmark.circle", word: "CI", kind: .failed) }
            if reason.contains("approved") { return RowBadge(symbol: "checkmark.circle", word: "Approved", kind: .completed) }
            if reason.contains("passed") { return RowBadge(symbol: "checkmark.circle", word: "Review", kind: .completed) }
            return RowBadge(symbol: "arrow.triangle.pull", word: "PR", kind: .working)
        case "queued", "pending":
            return RowBadge(symbol: "clock", word: "Queued", kind: .dead)
        case "provisioning", "launching":
            return RowBadge(symbol: "clock", word: "Starting", kind: .working)
        default:
            return nil
        }
    }
}

extension WatchItem {
    /// What a row is called. Default terminal titles are "<agent> · <dir>", so the
    /// leaf after the last separator is the distinctive part; user titles pass through.
    var rowName: String {
        if kind == .task, !mono.isEmpty { return mono }
        if let last = title.components(separatedBy: " · ").last?.trimmingCharacters(in: .whitespaces), !last.isEmpty { return last }
        return mono.isEmpty ? title : mono
    }

    /// The agent named in a default terminal title ("claude-code · web" → "claude-code").
    var rowAgent: String? {
        let parts = title.components(separatedBy: " · ")
        return parts.count > 1 ? parts.first : nil
    }

    var waitsOnYou: Bool { StatusKind.forState(state) == .needsInput || StatusKind.forState(state) == .failed }
}

/// Kind glyph at the head of a row, tinted by the row's status.
struct KindIcon: View {
    let item: WatchItem
    var size: CGFloat = 12

    var body: some View {
        let kind = StatusKind.forState(item.state)
        Group {
            switch item.kind {
            case .agent: OptioGlyph(size: size, style: kind.color)
            case .task: Image(systemName: "arrow.triangle.branch").font(.system(size: size, weight: .semibold))
            case .local: Image(systemName: "terminal").font(.system(size: size, weight: .semibold))
            }
        }
        .foregroundStyle(kind.color)
        .frame(width: size + 2, height: size + 2)
        .accessibilityLabel(kind.label)
    }
}

/// `[kind] name [server] ……… [badge] 4m [later]` on one line. The whole row is a deep
/// link; the Later button (needs-you rows only) is an App Intent and never opens the app.
struct GlanceRow: View {
    let item: WatchItem
    let now: Date
    var showsServer = false
    var showsLater = true
    /// Small family: no wait time, no Later; the name and the badge are all that fit.
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                HStack(spacing: 6) {
                    KindIcon(item: item)
                    Text(item.rowName)
                        .font(.system(.footnote, design: item.kind == .agent ? .default : .monospaced).weight(.semibold))
                        .foregroundStyle(Color.primary)
                        .lineLimit(1)
                        .truncationMode(.head)
                        .layoutPriority(compact ? 0 : 1)
                    if showsServer, let tag = ServerTag(item: item) { tag.dot() }
                    Spacer(minLength: 4)
                    if let badge = RowBadge.of(item) {
                        HStack(spacing: 3) {
                            Image(systemName: badge.symbol)
                            Text(badge.word)
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(badge.color)
                        .lineLimit(1)
                        .fixedSize(horizontal: compact, vertical: false)
                    }
                    if !compact {
                        Text(GlancePolicy.waitText(since: item.since, now: now))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Color(.tertiaryLabel))
                            .frame(minWidth: 24, alignment: .trailing)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            if showsLater, !compact, item.state == "needs_you" {
                Button(intent: LaterIntent(item: item)) {
                    Image(systemName: "moon.zzz")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.tertiary)
                        .frame(width: 22, height: 22)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Later")
            }
        }
    }
}

/// Directory basename / branch / slug: SF Mono, semibold, head-truncated so the leaf survives.
struct MonoPath: View {
    let text: String
    var weight: Font.Weight = .semibold
    var size: Font.TextStyle = .subheadline

    var body: some View {
        Text(text)
            .font(.system(size, design: .monospaced).weight(weight))
            .lineLimit(1)
            .truncationMode(.head)
    }
}

/// The needs-you count: yellow only when > 0, accentable under iOS 18 tinting.
struct CountText: View {
    let count: Int
    var style: Font = .system(size: 44, weight: .semibold, design: .rounded)
    var color: Color = GlanceStyle.needsYou

    var body: some View {
        Text("\(count)")
            .font(style)
            .foregroundStyle(count > 0 ? color : .secondary)
            .contentTransition(.numericText())
            .widgetAccentable(count > 0)
            .monospacedDigit()
    }
}

/// Status dot for one row: the same colour the pill would carry.
struct StateDotView: View {
    let state: String
    var size: CGFloat = 7

    var body: some View {
        let kind = StatusKind.forState(state)
        Circle().fill(kind.color).frame(width: size, height: size).accessibilityLabel(kind.label)
    }
}

/// "● MacBook": the server a row or section belongs to. Only rendered when the widget
/// mixes servers, or when it shows one server while others are paired. `dotOnly`
/// keeps just the coloured dot (rows in a multi-server list).
struct ServerTag: View {
    let name: String
    let color: ServerColor
    var size: Font = .caption2
    var weight: Font.Weight = .semibold
    var dotOnly = false

    init(name: String, color: ServerColor, size: Font = .caption2, weight: Font.Weight = .semibold) {
        self.name = name
        self.color = color
        self.size = size
        self.weight = weight
    }

    init(_ server: ServerProfile, size: Font = .caption2, weight: Font.Weight = .semibold) {
        self.init(name: server.shortName, color: server.color, size: size, weight: weight)
    }

    /// From an item's server fields; nil-safe (renders nothing without a server id).
    init?(item: WatchItem) {
        guard let id = item.serverId else { return nil }
        let p = ServerRegistry.profile(id)
        self.init(name: p?.shortName ?? item.serverName ?? "server", color: p?.color ?? .slate)
    }

    func dot() -> ServerTag { var t = self; t.dotOnly = true; return t }

    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(color.swiftUI).frame(width: 6, height: 6)
            if !dotOnly { Text(name).font(size.weight(weight)).lineLimit(1) }
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel("on \(name)")
    }
}

/// Compact honesty: `⌀ 10:42` (unreachable since) / `as of 10:42` (stale). Nothing
/// when live and fresh.
struct HonestyFooter: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .unreachable, let since = entry.unreachableSince {
            Label(GlanceStyle.time(since), systemImage: "wifi.slash")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                .accessibilityLabel("unreachable since \(GlanceStyle.time(since))")
        } else if entry.isMulti, let down = entry.unreachableSlices.first {
            HStack(spacing: 3) {
                Circle().fill(down.server.color.swiftUI).frame(width: 5, height: 5)
                Image(systemName: "wifi.slash")
            }
            .font(.caption2).foregroundStyle(.secondary)
            .accessibilityLabel("\(down.server.shortName) unreachable")
        } else if entry.isStale {
            Text("as of \(GlanceStyle.time(entry.asOf))")
                .font(.caption2).foregroundStyle(.tertiary).lineLimit(1)
        }
    }
}

/// Signed-out body shared by every family: one line, links to sign-in.
struct SignedOutView: View {
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            OptioGlyph(size: 18, style: .secondary)
            Text("Sign in to Optio").font(compact ? .footnote : .subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(DeepLink.section("more").url)
    }
}
