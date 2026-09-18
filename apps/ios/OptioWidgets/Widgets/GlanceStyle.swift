import SwiftUI
import WidgetKit

/// Visual language from docs/design/ios-glanceable-surfaces.md §3, shared by every widget.
/// Colour is the status palette (Shared/StatusColor.swift): yellow needs input,
/// purple working, green done, grey idle, red failed.
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

    var body: some View {
        Text("\(count)")
            .font(style)
            .foregroundStyle(count > 0 ? GlanceStyle.needsYou : .secondary)
            .contentTransition(.numericText())
            .widgetAccentable(count > 0)
            .monospacedDigit()
    }
}

/// State pill tinted through the status palette: purple working, yellow needs
/// input, green done, red failed, grey stopped.
struct StatePill: View {
    let state: String

    private var kind: StatusKind { StatusKind.forState(state) }

    var body: some View {
        Text(state.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(kind == .dead ? AnyShapeStyle(.quaternary) : AnyShapeStyle(kind.color.opacity(0.18)), in: Capsule())
            .foregroundStyle(kind == .dead ? AnyShapeStyle(.secondary) : AnyShapeStyle(kind.color))
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
/// mixes servers, or when it shows one server while others are paired.
struct ServerTag: View {
    let name: String
    let color: ServerColor
    var size: Font = .caption2
    var weight: Font.Weight = .semibold

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

    var body: some View {
        HStack(spacing: 3) {
            Circle().fill(color.swiftUI).frame(width: 6, height: 6)
            Text(name).font(size.weight(weight)).lineLimit(1)
        }
        .foregroundStyle(.secondary)
        .accessibilityLabel("on \(name)")
    }
}

/// Section header inside a multi-server widget: tag + count for that server.
struct ServerSectionHeader: View {
    let slice: GlanceSlice
    var count: Int? = nil

    var body: some View {
        HStack(spacing: 4) {
            ServerTag(slice.server)
            if let count, count > 0 {
                Text("\(count)").font(.caption2.weight(.semibold)).foregroundStyle(.secondary).contentTransition(.numericText())
            }
            if slice.reachability == .unreachable {
                Image(systemName: "wifi.slash").font(.caption2).foregroundStyle(.tertiary)
            }
            Spacer(minLength: 0)
        }
        .padding(.top, 2)
    }
}

/// "as of 10:42" (stale) / "Laptop unreachable since 10:42" (offline) / "● Studio
/// unreachable" (one of several). Nothing when live and fresh.
struct HonestyFooter: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .unreachable, let since = entry.unreachableSince {
            Text("\(entry.server?.shortName ?? "Laptop") unreachable since \(GlanceStyle.time(since))")
                .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
        } else if entry.isMulti, let down = entry.unreachableSlices.first {
            HStack(spacing: 3) {
                Circle().fill(down.server.color.swiftUI).frame(width: 5, height: 5)
                Text(entry.unreachableSlices.count > 1 ? "\(entry.unreachableSlices.count) unreachable" : "\(down.server.shortName) unreachable")
            }
            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
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
