import SwiftUI
import WidgetKit

/// Visual language from docs/design/ios-glanceable-surfaces.md §3, shared by every widget.
enum GlanceStyle {
    /// Purple (#6d28d9) means "you". It appears only when something needs you.
    static let purple = Color(red: 0x6D / 255, green: 0x28 / 255, blue: 0xD9 / 255)
    /// The Optio glyph: a terminal caret in a rounded square (hierarchical rendering).
    static let glyph = "apple.terminal"

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

/// The needs-you count: purple only when > 0, accentable under iOS 18 tinting.
struct CountText: View {
    let count: Int
    var style: Font = .system(size: 44, weight: .semibold, design: .rounded)

    var body: some View {
        Text("\(count)")
            .font(style)
            .foregroundStyle(count > 0 ? GlanceStyle.purple : .secondary)
            .contentTransition(.numericText())
            .widgetAccentable(count > 0)
            .monospacedDigit()
    }
}

/// Small grey state pill (no colour coding: hierarchy comes from weight).
struct StatePill: View {
    let state: String

    var body: some View {
        Text(state.replacingOccurrences(of: "_", with: " "))
            .font(.caption2.weight(.semibold))
            .textCase(.uppercase)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(.quaternary, in: Capsule())
            .foregroundStyle(.secondary)
    }
}

/// "as of 10:42" (stale) / "Laptop unreachable since 10:42" (offline). Nothing when live and fresh.
struct HonestyFooter: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .unreachable, let since = entry.unreachableSince {
            Text("Laptop unreachable since \(GlanceStyle.time(since))")
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
            Image(systemName: GlanceStyle.glyph).symbolRenderingMode(.hierarchical).foregroundStyle(.secondary)
            Text("Sign in to Optio").font(compact ? .footnote : .subheadline).foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .widgetURL(DeepLink.section("more").url)
    }
}
