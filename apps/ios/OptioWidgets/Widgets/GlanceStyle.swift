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

/// The session's Who as a glyph: a terminal, or the Optio bot for an agent runtime.
/// Shared by the island's compact trailing region and the accessory rows.
struct WhoGlyph: View {
    let item: WatchItem
    var size: CGFloat = 14
    var style: AnyShapeStyle = AnyShapeStyle(.primary)

    var body: some View {
        if item.whoIsTerminal {
            Image(systemName: "terminal").font(.system(size: size, weight: .semibold)).foregroundStyle(style)
                .frame(width: size + 4, height: size + 4)
                .accessibilityLabel("terminal")
        } else {
            OptioGlyph(size: size + 2, style: style)
                .accessibilityLabel(GlanceCopy.whoLabel(item.whoValue))
        }
    }
}

// MARK: - Session vocabulary (When · Where · Who · Then)

/// One attribute chip: `[icon] label`, the same icons as the app's `SessionRowView`.
struct SessionChip: View {
    let systemImage: String
    let label: String
    var mono = false
    var font: Font = .caption2

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).font(font).foregroundStyle(Color(.tertiaryLabel))
            Text(label)
                .font(mono ? font.monospaced() : font)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
                .truncationMode(mono ? .head : .tail)
        }
    }
}

/// The four chips of a session: one line (`short` trims Where to `host · leaf` so four
/// chips fit a widget row) or, with `grid`, two columns of two like the app's session
/// row — the Live Activity uses that so Where never has to be squeezed.
struct SessionChips: View {
    let item: WatchItem
    var short = true
    var grid = false
    var font: Font = .caption2
    var spacing: CGFloat = 8

    var body: some View {
        let place = item.whereValue
        let when = SessionChip(systemImage: item.whenSystemImage, label: item.whenLabel, font: font)
        let whereChip = SessionChip(systemImage: place.systemImage, label: GlanceCopy.whereLabel(place.detail, target: place.target.rawValue, short: short), mono: true, font: font)
        let who = SessionChip(systemImage: item.whoSystemImage, label: GlanceCopy.whoLabel(item.whoValue), font: font)
        let then = SessionChip(systemImage: item.thenValue.systemImage, label: item.thenValue.label, font: font)
        if grid {
            Grid(alignment: .leading, horizontalSpacing: spacing, verticalSpacing: 2) {
                GridRow { when; whereChip }
                GridRow { who; then }
            }
            .lineLimit(1)
        } else {
            HStack(spacing: spacing) {
                when.fixedSize()
                whereChip.layoutPriority(-1)
                who.fixedSize()
                then.fixedSize()
            }
            .lineLimit(1)
        }
    }
}

/// Status word for a row: the widget vocabulary (`Allow?`, `Reply`, `PR`…) when it
/// has one, else the session row's own status label ("working", "PR open").
extension WatchItem {
    var statusWord: String { RowBadge.of(self)?.word ?? statusText }
    var statusSymbol: String? { RowBadge.of(self)?.symbol }
    var statusColor: Color { RowBadge.of(self)?.color ?? StatusKind.forState(state).color }
}

/// A session as a widget row. One line — `● name  [where]  status 4m` — or two, with
/// the four chips underneath (`expanded`). The row is a deep link; the moon is
/// **Later** (App Intent, no app launch) on needs-you rows.
struct SessionGlanceRow: View {
    let item: WatchItem
    let now: Date
    var showsServer = false
    var showsLater = true
    var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .center, spacing: 6) {
                Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                    HStack(spacing: 6) {
                        StateDotView(state: item.state, size: 7)
                        Text(item.rowName)
                            .font(.footnote.weight(.semibold))
                            .foregroundStyle(Color.primary)
                            .lineLimit(1)
                            .truncationMode(.tail)
                            .layoutPriority(1)
                        if showsServer, let tag = ServerTag(item: item) { tag.dot() }
                        if !expanded {
                            let place = item.whereValue
                            SessionChip(systemImage: place.systemImage, label: GlanceCopy.whereLabel(place.detail, target: place.target.rawValue, short: true), mono: true)
                                .layoutPriority(0)
                        }
                        Spacer(minLength: 4)
                        HStack(spacing: 3) {
                            if let symbol = item.statusSymbol { Image(systemName: symbol) }
                            Text(item.statusWord)
                        }
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(item.statusColor)
                        .lineLimit(1)
                        .fixedSize(horizontal: true, vertical: false)
                        Text(GlancePolicy.waitText(since: item.since, now: now))
                            .font(.caption2.monospacedDigit())
                            .foregroundStyle(Color(.tertiaryLabel))
                            .frame(minWidth: 22, alignment: .trailing)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                if showsLater, item.state == "needs_you" {
                    Button(intent: LaterIntent(item: item)) {
                        Image(systemName: "moon.zzz")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.tertiary)
                            .frame(width: 22, height: 18)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Later")
                }
            }
            if expanded {
                Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                    SessionChips(item: item).padding(.leading, 13)
                }
            }
        }
    }
}

/// The session board's tiles in one row: count over label, each a link into the
/// matching Sessions view. Need-you is yellow and Running purple when non-zero.
struct TileStrip: View {
    let tiles: [GlanceCopy.Tile]
    var compact = false

    var body: some View {
        HStack(spacing: 6) {
            ForEach(tiles, id: \.id) { tile in
                Link(destination: DeepLink.sessions(view: tile.view).url) {
                    VStack(alignment: .leading, spacing: 0) {
                        Text("\(tile.count)")
                            .font(.system(compact ? .callout : .title3, design: .rounded).weight(.semibold))
                            .foregroundStyle(color(tile))
                            .contentTransition(.numericText())
                            .monospacedDigit()
                        Text(tile.label)
                            .font(.system(size: 9, weight: .medium))
                            .foregroundStyle(Color.secondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 7)
                    .padding(.vertical, 4)
                    .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
                }
            }
        }
    }

    private func color(_ tile: GlanceCopy.Tile) -> Color {
        switch tile.id {
        case .needsYou: return tile.count > 0 ? GlanceStyle.needsYou : .secondary
        case .running: return tile.count > 0 ? GlanceStyle.working : .secondary
        default: return tile.count > 0 ? .primary : .secondary
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
