import SwiftUI
import WidgetKit

/// "Needs You": the Watch, persisted. Home screen small/medium plus every lock-screen
/// accessory family. Purple only when something needs you; grey "Quiet" otherwise.
struct NeedsYouWidget: Widget {
    static let kind = WidgetKinds.needsYou

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: Self.kind, provider: GlanceTimelineProvider()) { entry in
            NeedsYouView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Needs You")
        .description("What's waiting on you.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct NeedsYouView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryCircular: NeedsYouCircular(entry: entry)
        case .accessoryRectangular: NeedsYouRectangular(entry: entry)
        case .accessoryInline: NeedsYouInline(entry: entry)
        case .systemMedium: NeedsYouMedium(entry: entry)
        default: NeedsYouSmall(entry: entry)
        }
    }
}

// MARK: - Home screen

struct NeedsYouSmall: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack {
                    Image(systemName: GlanceStyle.glyph)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(entry.count > 0 ? GlanceStyle.purple : .secondary)
                        .widgetAccentable(entry.count > 0)
                    Spacer()
                    if entry.reachability == .unreachable {
                        Image(systemName: "wifi.slash").foregroundStyle(.tertiary)
                    }
                }
                .font(.subheadline)
                Spacer(minLength: 0)
                if entry.count > 0 {
                    CountText(count: entry.count)
                    Text(entry.count == 1 ? "needs you" : "need you")
                        .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                    if let head = entry.needsYou.first {
                        MonoPath(text: head.mono, size: .footnote).foregroundStyle(.primary)
                    }
                } else {
                    Text("Quiet").font(.title.weight(.semibold)).foregroundStyle(.secondary)
                    Text(entry.running.isEmpty ? "nothing running" : "\(entry.running.count) running")
                        .font(.footnote).foregroundStyle(.tertiary)
                }
                HonestyFooter(entry: entry)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(entry.needsYou.first.flatMap { URL(string: $0.link) } ?? DeepLink.needsYou.url)
        }
    }
}

struct NeedsYouMedium: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            VStack(alignment: .leading, spacing: 6) {
                HStack(spacing: 6) {
                    Image(systemName: GlanceStyle.glyph)
                        .symbolRenderingMode(.hierarchical)
                        .foregroundStyle(entry.count > 0 ? GlanceStyle.purple : .secondary)
                        .widgetAccentable(entry.count > 0)
                    if entry.count > 0 {
                        Text("\(entry.count)")
                            .contentTransition(.numericText())
                            .foregroundStyle(GlanceStyle.purple)
                            .widgetAccentable()
                        Text(entry.count == 1 ? "needs you" : "need you").foregroundStyle(.secondary)
                    } else {
                        Text("Quiet").foregroundStyle(.secondary)
                        if !entry.running.isEmpty {
                            Text("· \(entry.running.count) running").foregroundStyle(.tertiary)
                        }
                    }
                    Spacer()
                    HonestyFooter(entry: entry)
                }
                .font(.subheadline.weight(.semibold))
                if entry.count > 0 {
                    ForEach(entry.needsYou.prefix(3)) { item in
                        NeedsYouRow(item: item, now: entry.date)
                    }
                } else {
                    Spacer(minLength: 0)
                    Text("Nothing waiting on you.")
                        .font(.footnote).foregroundStyle(.tertiary)
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

/// `path · reason · wait` with the whole row a deep link and an interactive Later button.
struct NeedsYouRow: View {
    let item: WatchItem
    let now: Date

    var body: some View {
        HStack(spacing: 8) {
            Link(destination: URL(string: item.link) ?? DeepLink.needsYou.url) {
                HStack(spacing: 6) {
                    MonoPath(text: item.mono, size: .footnote)
                        .frame(maxWidth: 120, alignment: .leading)
                    Text(item.reason ?? "Needs you")
                        .font(.footnote).foregroundStyle(.secondary).lineLimit(1)
                    Spacer(minLength: 0)
                    Text(item.since, style: .relative)
                        .font(.caption.monospacedDigit()).foregroundStyle(.tertiary).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            Button(intent: LaterIntent(item: item)) {
                Text("Later").font(.caption.weight(.semibold))
            }
            .buttonStyle(.bordered)
            .buttonBorderShape(.capsule)
            .controlSize(.mini)
            .tint(.secondary)
        }
    }
}

// MARK: - Accessories (monochrome by design)

struct NeedsYouCircular: View {
    let entry: GlanceEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Circle().strokeBorder(.primary.opacity(entry.count > 0 ? 1 : 0.35), lineWidth: 3)
            if entry.reachability == .signedOut {
                Image(systemName: GlanceStyle.glyph).font(.caption)
            } else if entry.count > 0 {
                Text("\(entry.count)")
                    .font(.system(.title3, design: .rounded).weight(.bold))
                    .contentTransition(.numericText())
                    .widgetAccentable()
            }
        }
        .widgetURL(entry.needsYou.first.flatMap { URL(string: $0.link) } ?? DeepLink.needsYou.url)
    }
}

struct NeedsYouRectangular: View {
    let entry: GlanceEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch entry.reachability {
            case .signedOut:
                Text("Optio").font(.headline)
                Text("Sign in to Optio").font(.caption).foregroundStyle(.secondary)
            case .unreachable where entry.count == 0:
                Text("Optio").font(.headline)
                Text("Laptop unreachable").font(.caption)
                if let since = entry.unreachableSince { Text("since \(GlanceStyle.time(since))").font(.caption).foregroundStyle(.secondary) }
            default:
                if let head = entry.needsYou.first {
                    HStack(spacing: 4) {
                        Text("Needs you").font(.headline).widgetAccentable()
                        if entry.count > 1 { Text("+\(entry.count - 1)").font(.caption).foregroundStyle(.secondary) }
                    }
                    MonoPath(text: head.mono, size: .caption)
                    Text(GlancePolicy.waitText(since: head.since, now: entry.date))
                        .font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Optio").font(.headline)
                    Text("Quiet").font(.caption)
                    Text(entry.running.isEmpty ? "nothing running" : "\(entry.running.count) running")
                        .font(.caption).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(entry.reachability == .signedOut ? DeepLink.section("more").url : (entry.needsYou.first.flatMap { URL(string: $0.link) } ?? DeepLink.needsYou.url))
    }
}

struct NeedsYouInline: View {
    let entry: GlanceEntry

    var body: some View {
        switch entry.reachability {
        case .signedOut: Text("Optio · sign in")
        case .unreachable where entry.count == 0: Text("Optio · unreachable")
        default:
            if entry.count > 0 {
                Text("Optio · \(entry.count) need\(entry.count == 1 ? "s" : "") you")
            } else {
                Text("Optio · quiet")
            }
        }
    }
}

// MARK: - Previews

#Preview("Small · waiting", as: .systemSmall) { NeedsYouWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.stale
}
#Preview("Small · offline / signed out", as: .systemSmall) { NeedsYouWidget() } timeline: {
    GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Medium · waiting", as: .systemMedium) { NeedsYouWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.stale
}
#Preview("Medium · quiet / offline / signed out", as: .systemMedium) { NeedsYouWidget() } timeline: {
    GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Circular", as: .accessoryCircular) { NeedsYouWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Rectangular", as: .accessoryRectangular) { NeedsYouWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Inline", as: .accessoryInline) { NeedsYouWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
