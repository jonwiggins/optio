import SwiftUI
import WidgetKit

/// Visual language from docs/design/ios-glanceable-surfaces.md §3, shared by every widget.
/// Colour is the status palette (Shared/StatusColor.swift): green needs input,
/// purple working, grey done / idle, yellow problems.
///
/// Widgets are narrow: rows never carry a sentence. Each state maps to one symbol and
/// one word (`RowBadge`), names are the leaf of a path, and waits are "4m", not
/// "4 min. ago".
enum GlanceStyle {
    /// Green: something needs you.
    static let needsYou = StatusColor.green
    /// Purple: agents are working.
    static let working = StatusColor.purple
    /// SF Symbol stand-in for surfaces that only accept symbols (Control Center).
    static let glyph = "apple.terminal"

    /// Header glyph: the bot, green when `count` items need you, else grey.
    static func headerGlyph(needsYou count: Int, size: CGFloat = 16) -> some View {
        OptioGlyph(size: size, style: count > 0 ? AnyShapeStyle(needsYou) : AnyShapeStyle(.secondary))
            .widgetAccentable(count > 0)
    }

    static let clock: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .none; f.timeStyle = .short; return f
    }()

    static func time(_ date: Date) -> String { clock.string(from: date) }
}

extension View {
    /// Text on the glanceable surfaces scales with the user's setting up to xLarge and
    /// stops there. A widget or Live Activity has a fixed size (the lock screen clips a
    /// Live Activity past 160 pt), so larger text would only turn values into ellipses.
    /// Every layout is checked at xLarge on the smallest phone (WidgetSnapshots).
    func glanceTypeClamp() -> some View {
        dynamicTypeSize(...DynamicTypeSize.xLarge)
    }
}

/// A live "since" clock (`Text(date, style: .timer)`, or a count-up interval) sized to
/// the widest value it can show: an invisible template ("00:00", "0:00:00", …) sets the
/// width at the current font and text size, and the timer draws over it,
/// right-aligned. It never wraps and never takes the row's whole width, which is what
/// a bare timer text does in a widget.
struct FitTimer: View {
    let since: Date
    /// Count up as a stopwatch (working) rather than the `.timer` style (waiting).
    var countUp = false
    var font: Font = .subheadline.weight(.semibold)
    var style: AnyShapeStyle = AnyShapeStyle(.secondary)
    var now: Date = .now

    /// The widest string the clock shows over the next half hour. Minutes ("59:59")
    /// under an hour, then H:MM:SS with as many hour digits as it needs.
    static func template(elapsed: TimeInterval) -> String {
        let soon = elapsed + 30 * 60
        if soon < 3600 { return "00:00" }
        let hourDigits = String(max(1, Int(soon / 3600))).count
        return String(repeating: "0", count: hourDigits) + ":00:00"
    }

    var body: some View {
        Text(Self.template(elapsed: max(0, now.timeIntervalSince(since))))
            .font(font.monospacedDigit())
            .hidden()
            .overlay(alignment: .trailing) {
                Group {
                    if countUp {
                        Text(timerInterval: since...since.addingTimeInterval(8 * 3600), countsDown: false)
                    } else {
                        Text(since, style: .timer)
                    }
                }
                .font(font.monospacedDigit())
                .foregroundStyle(style)
                .multilineTextAlignment(.trailing)
                .lineLimit(1)
            }
            .fixedSize()
    }
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
        if kind == .task, !title.isEmpty { return title }
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
    var colored = false
    @Environment(\.widgetRenderingMode) private var renderingMode

    var body: some View {
        AgentMark(runtime: item.whoValue, size: size, fallback: "cpu", label: GlanceCopy.whoLabel(item.whoValue))
            .foregroundStyle(markStyle)
            .frame(width: size + 4, height: size + 4)
    }

    private var markStyle: AnyShapeStyle {
        guard colored, renderingMode == .fullColor else { return style }
        switch Brand(agentType: item.whoValue) {
        case .claude: return AnyShapeStyle(Color(red: 0.85, green: 0.47, blue: 0.34))
        case .gemini: return AnyShapeStyle(LinearGradient(colors: [.blue, .purple, .pink], startPoint: .topLeading, endPoint: .bottomTrailing))
        default: return AnyShapeStyle(Color.primary)
        }
    }
}

// MARK: - Session vocabulary (When · Where · Who · Then)

/// One attribute chip: `[icon] label`, the same icons as the app's `WorkRowView`. The
/// label is a standard value and always renders whole; rows choose which chips fit
/// (`SessionChipsLine`) rather than shortening one.
struct SessionChip: View {
    let systemImage: String
    let label: String
    var mono = false
    var font: Font = .caption2

    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: systemImage).font(font).foregroundStyle(Color.secondary)
            Text(label)
                .font(mono ? font.monospaced() : font)
                .foregroundStyle(Color.secondary)
                .lineLimit(1)
        }
        .fixedSize()
    }
}

/// A session's chips on one line, fitted whole: the most that fit, in order of use —
/// Where, Who, When, Then — with Where as long as the room allows (full path, then
/// `host · leaf`, then the leaf). Nothing is cut mid-word.
struct SessionChipsLine: View {
    let item: WatchItem
    var font: Font = .caption2
    var spacing: CGFloat = 10

    var body: some View {
        let place = item.whereValue
        let wheres = GlanceCopy.whereOptions(place.detail, target: place.target.rawValue)
        let whereChip = { (label: String) in SessionChip(systemImage: place.systemImage, label: label, mono: true, font: font) }
        let who = SessionChip(systemImage: item.whoSystemImage, label: GlanceCopy.whoLabel(item.whoValue), font: font)
        let when = SessionChip(systemImage: item.whenSystemImage, label: item.whenLabel, font: font)
        let then = SessionChip(systemImage: item.thenValue.systemImage, label: item.thenValue.label, font: font)
        let short = wheres.count > 1 ? wheres[1] : wheres[0]
        let leaf = wheres[wheres.count - 1]
        ViewThatFits(in: .horizontal) {
            HStack(spacing: spacing) { whereChip(wheres[0]); who; when; then }
            HStack(spacing: spacing) { whereChip(short); who; when; then }
            HStack(spacing: spacing) { whereChip(short); who; when }
            HStack(spacing: spacing) { whereChip(short); who }
            HStack(spacing: spacing) { whereChip(leaf); who; when }
            HStack(spacing: spacing) { whereChip(leaf); who }
            HStack(spacing: spacing) { whereChip(leaf) }
        }
    }
}

/// The status of a row as one symbol and one word, whole: `✋ Allow?`, `💬 Reply`,
/// `PR`, or the session row's own label.
struct StatusBadge: View {
    let item: WatchItem
    var font: Font = .caption2.weight(.semibold)

    var body: some View {
        HStack(spacing: 3) {
            if let symbol = item.statusSymbol { Image(systemName: symbol) }
            Text(item.statusWord)
        }
        .font(font)
        .foregroundStyle(item.statusColor)
        .lineLimit(1)
        .fixedSize()
    }
}

/// Status word for a row: the widget vocabulary (`Allow?`, `Reply`, `PR`…) when it
/// has one, else the session row's own status label ("working", "PR open").
extension WatchItem {
    var statusWord: String { RowBadge.of(self)?.word ?? statusText }
    var statusSymbol: String? { RowBadge.of(self)?.symbol }
    var statusColor: Color { RowBadge.of(self)?.color ?? StatusKind.forState(state).color }
}

/// A session keeps its name on the first line; status and location form the second.
/// This leaves the title room on medium widgets and keeps the Later action separate.
struct SessionGlanceRow: View {
    let item: WatchItem
    let now: Date
    var showsServer = false
    var showsLater = true
    var expanded = false

    var body: some View {
        HStack(spacing: 8) {
            Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                HStack(alignment: .center, spacing: 8) {
                    WhoGlyph(item: item, size: expanded ? 18 : 15, colored: true)
                        .accessibilityHidden(true)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 4) {
                            Text(item.rowName).font(.subheadline.weight(.semibold))
                                .foregroundStyle(Color.primary).lineLimit(1)
                            if showsServer, let tag = ServerTag(item: item) { tag.dot() }
                        }
                        HStack(spacing: 6) {
                            StatusBadge(item: item)
                            if expanded {
                                Text(GlanceCopy.whereOptions(item.whereValue.detail, target: item.whereValue.target.rawValue).last ?? item.whereValue.label)
                                    .font(.caption2).foregroundStyle(Color.secondary).lineLimit(1)
                            }
                        }
                    }
                    Spacer(minLength: 0)
                    Text(GlancePolicy.waitText(since: item.since, now: now))
                        .font(.caption2.monospacedDigit()).foregroundStyle(Color.secondary)
                        .fixedSize()
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .accessibilityElement(children: .combine)
            }
            if showsLater, item.state == "needs_you" {
                Button(intent: LaterIntent(item: item)) {
                    Image(systemName: "moon.zzz").font(.caption.weight(.semibold))
                        .foregroundStyle(Color.secondary)
                        .frame(width: 30, height: 30)
                        .background(.fill.tertiary, in: Circle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Remind me later: \(item.rowName)")
            }
        }
    }
}

/// Primary counts are generous and aligned; saved-work counts stay secondary.
struct TileStrip: View {
    let tiles: [GlanceCopy.Tile]
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .top, spacing: 20) {
                ForEach(Array(tiles.prefix(2)), id: \.id) { tile in
                    Link(destination: DeepLink.work(view: tile.view).url) {
                        GlanceMetric(count: tile.count, label: tile.label,
                                     color: tile.id == .needsYou ? GlanceStyle.needsYou : GlanceStyle.working,
                                     compact: compact)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
            }
            SavedWorkCounts(tiles: tiles)
        }
    }
}

struct SavedWorkCounts: View {
    let tiles: [GlanceCopy.Tile]

    var body: some View {
        if tiles.count > 2 {
            HStack(spacing: 8) {
                ForEach(Array(tiles.dropFirst(2)), id: \.id) { tile in
                    Link(destination: DeepLink.work(view: tile.view).url) {
                        HStack(spacing: 4) {
                            Text("\(tile.count)").fontWeight(.semibold).foregroundStyle(Color.primary)
                            Text(tile.label).foregroundStyle(Color.secondary)
                        }
                        .font(.caption2).monospacedDigit().lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .accessibilityElement(children: .combine)
                    }
                }
            }
        }
    }
}

/// The system still owns margins, rounding, and accented/vibrant appearances.
struct GlanceBackground: View {
    @Environment(\.colorScheme) private var scheme
    var body: some View {
        Color(uiColor: scheme == .dark
              ? UIColor(red: 0.105, green: 0.098, blue: 0.12, alpha: 1)
              : UIColor(red: 0.985, green: 0.98, blue: 0.995, alpha: 1))
    }
}

/// Shared count typography for the Home Screen and expanded Dynamic Island.
struct GlanceMetric: View {
    let count: Int
    let label: String
    let color: Color
    var compact = false
    var alignment: HorizontalAlignment = .leading

    var body: some View {
        VStack(alignment: alignment, spacing: 2) {
            Text("\(count)")
                .font(.system(compact ? .title2 : .largeTitle, design: .rounded).weight(.semibold).monospacedDigit())
                .foregroundStyle(count > 0 ? color : Color.secondary)
                .widgetAccentable(count > 0)
                .contentTransition(.numericText())
            Text(label).font(.caption2.weight(.medium)).foregroundStyle(Color.secondary)
        }
        .lineLimit(1)
        .fixedSize()
        .accessibilityElement(children: .combine)
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
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
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
