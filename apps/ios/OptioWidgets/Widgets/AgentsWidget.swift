import SwiftUI
import WidgetKit

/// "Agents": the one status widget. What needs you first (yellow), then what's working
/// (purple), one row each, every row a deep link into that item. Small shows the count
/// and the top row; medium three rows; large seven plus the Repo Tasks in flight.
/// Lock-screen families show the oldest needs-you item.
///
/// Configurable per server: left empty it shows every paired server, with a coloured
/// server dot on each row instead of sections, so rows keep their width.
///
/// Keeps the original "Needs You" kind id so widgets already on a home screen survive
/// the rename.
struct AgentsWidget: Widget {
    static let kind = WidgetKinds.agents

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: GlanceConfigurationIntent.self, provider: GlanceTimelineProvider(includeTasks: true)) { entry in
            AgentsView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Agents")
        .description("What needs you, then what's working. Tap a row to jump in.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct AgentsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryCircular: AgentsCircular(entry: entry)
        case .accessoryRectangular: AgentsRectangular(entry: entry)
        case .accessoryInline: AgentsInline(entry: entry)
        case .systemMedium: AgentsList(entry: entry, budget: 3)
        case .systemLarge: AgentsList(entry: entry, budget: 7, withTasks: true)
        default: AgentsSmall(entry: entry)
        }
    }
}

// MARK: - Rows

extension GlanceEntry {
    /// Needs-you items first (oldest first, snoozed last), then running (newest first).
    var rows: [WatchItem] { needsYou + running }

    /// Where a tap on the widget chrome lands: the oldest needs-you item, else the
    /// newest running one, else the Local hub.
    var headLink: URL {
        (needsYou.first ?? running.first).flatMap { URL(string: $0.link) } ?? DeepLink.needsYou.url
    }

    /// Repo Tasks in flight that are not already rows (followed tasks join `rows`).
    var taskRows: [WatchItem] {
        let seen = Set(rows.map(\.id))
        return tasks.filter { !seen.contains($0.id) }.map { t in
            let reason: String? = switch t.prChecksStatus {
            case "failing": "CI failing"
            case "passing": "CI passed"
            default: nil
            }
            return WatchItem(kind: .task, id: t.id, title: t.title, mono: t.branch.isEmpty ? (t.prNumber.map { "#\($0)" } ?? t.title) : t.branch,
                             reason: reason, since: t.since == .distantPast ? date : t.since, state: t.state,
                             link: DeepLink.task(t.id).url(server: t.serverId).absoluteString, prUrl: t.prUrl,
                             serverId: t.serverId, serverName: t.serverName)
        }
    }
}

// MARK: - Header

/// `[bot] 3 need you · 2 working [server]      [footer]`, or `Quiet` when nothing is on.
struct AgentsHeader: View {
    let entry: GlanceEntry

    var body: some View {
        HStack(spacing: 5) {
            GlanceStyle.headerGlyph(needsYou: entry.count)
            if entry.count > 0 {
                Text("\(entry.count)").foregroundStyle(GlanceStyle.needsYou).contentTransition(.numericText()).widgetAccentable()
                Text(entry.count == 1 ? "needs you" : "need you").foregroundStyle(.secondary)
            }
            if !entry.running.isEmpty {
                if entry.count > 0 { Text("·").foregroundStyle(.tertiary) }
                Text("\(entry.running.count)").foregroundStyle(GlanceStyle.working).contentTransition(.numericText())
                Text("working").foregroundStyle(.secondary)
            }
            if entry.count == 0, entry.running.isEmpty {
                Text("Quiet").foregroundStyle(.secondary)
            }
            if entry.showsServerName, let s = entry.server {
                ServerTag(s)
            }
            Spacer(minLength: 4)
            HonestyFooter(entry: entry)
        }
        .font(.subheadline.weight(.semibold))
        .lineLimit(1)
    }
}

// MARK: - Home screen

/// Count on top, the top row underneath, so the number is never a dead end.
struct AgentsSmall: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    GlanceStyle.headerGlyph(needsYou: entry.count, size: 18)
                    if entry.showsServerName, let s = entry.server {
                        ServerTag(s)
                    } else if entry.isMulti {
                        Text("\(entry.slices.count) servers").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    HonestyFooter(entry: entry)
                }
                Spacer(minLength: 0)
                if entry.count > 0 {
                    CountText(count: entry.count)
                    Text(entry.count == 1 ? "needs you" : "need you")
                        .font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                } else if !entry.running.isEmpty {
                    CountText(count: entry.running.count, color: GlanceStyle.working)
                    Text("working").font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                } else {
                    Text("Quiet").font(.title.weight(.semibold)).foregroundStyle(.secondary)
                    Text("nothing running").font(.footnote).foregroundStyle(.tertiary)
                }
                if let head = entry.rows.first {
                    GlanceRow(item: head, now: entry.date, showsServer: entry.isMulti, showsLater: false, compact: true)
                        .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(entry.headLink)
        }
    }
}

/// Medium and large: header plus rows within a budget, then (large) Repo Tasks in flight.
struct AgentsList: View {
    let entry: GlanceEntry
    let budget: Int
    var withTasks = false

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            let rows = entry.rows
            let shown = Array(rows.prefix(budget))
            let overflow = rows.count - shown.count
            let tasks = withTasks ? Array(entry.taskRows.prefix(max(0, 3 - max(0, shown.count - (budget - 3))))) : []
            VStack(alignment: .leading, spacing: 5) {
                AgentsHeader(entry: entry)
                if rows.isEmpty {
                    Spacer(minLength: 0)
                    HStack(spacing: 6) {
                        Image(systemName: entry.reachability == .unreachable ? "wifi.slash" : "moon.zzz")
                        Text(entry.reachability == .unreachable ? "Unreachable" : "Nothing running")
                    }
                    .font(.footnote).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: 0)
                } else {
                    ForEach(shown) { item in
                        GlanceRow(item: item, now: entry.date, showsServer: entry.isMulti)
                    }
                    if overflow > 0 {
                        Link(destination: DeepLink.needsYou.url) {
                            Text("+\(overflow) more").font(.caption2.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
                        }
                    }
                }
                if !tasks.isEmpty {
                    HStack(spacing: 4) {
                        Image(systemName: "arrow.triangle.branch")
                        Text("Tasks")
                    }
                    .font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    .padding(.top, 2)
                    ForEach(tasks) { item in
                        GlanceRow(item: item, now: entry.date, showsServer: entry.isMulti, showsLater: false)
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Accessories (monochrome by design)

struct AgentsCircular: View {
    let entry: GlanceEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Circle().strokeBorder(.primary.opacity(entry.count > 0 ? 1 : 0.35), lineWidth: 3)
            if entry.reachability == .signedOut {
                OptioGlyph(size: 16, style: .primary)
            } else if entry.count > 0 {
                Text("\(entry.count)")
                    .font(.system(.title3, design: .rounded).weight(.bold))
                    .contentTransition(.numericText())
                    .widgetAccentable()
            } else if !entry.running.isEmpty {
                Text("\(entry.running.count)")
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .foregroundStyle(.secondary)
                    .contentTransition(.numericText())
            }
        }
        .widgetURL(entry.headLink)
    }
}

/// `Needs you +2` / `[terminal] web · Allow?` / `4m · MacBook`, the oldest item only.
struct AgentsRectangular: View {
    let entry: GlanceEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch entry.reachability {
            case .signedOut:
                Text("Optio").font(.headline)
                Text("Sign in").font(.caption).foregroundStyle(.secondary)
            case .unreachable where entry.count == 0:
                Text("Optio").font(.headline)
                Label(entry.unreachableSince.map(GlanceStyle.time) ?? "Unreachable", systemImage: "wifi.slash").font(.caption)
            default:
                if let head = entry.needsYou.first {
                    HStack(spacing: 4) {
                        Text("Needs you").font(.headline).widgetAccentable()
                        if entry.count > 1 { Text("+\(entry.count - 1)").font(.caption).foregroundStyle(.secondary) }
                    }
                    AccessoryItemLine(item: head)
                    HStack(spacing: 4) {
                        Text(GlancePolicy.waitText(since: head.since, now: entry.date))
                        if entry.isMulti || entry.showsServerName, let name = head.serverName {
                            Text("· \(name)").lineLimit(1)
                        }
                    }
                    .font(.caption).foregroundStyle(.secondary)
                } else if let head = entry.running.first {
                    HStack(spacing: 4) {
                        Text("Working").font(.headline)
                        if entry.running.count > 1 { Text("+\(entry.running.count - 1)").font(.caption).foregroundStyle(.secondary) }
                    }
                    AccessoryItemLine(item: head)
                    Text(GlancePolicy.waitText(since: head.since, now: entry.date)).font(.caption).foregroundStyle(.secondary)
                } else {
                    Text("Optio").font(.headline)
                    Label("Quiet", systemImage: "moon.zzz").font(.caption)
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .widgetURL(entry.reachability == .signedOut ? DeepLink.section("more").url : entry.headLink)
    }
}

/// `[kind] name · Word` for the lock screen: monochrome, one line.
struct AccessoryItemLine: View {
    let item: WatchItem

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: item.kind == .task ? "arrow.triangle.branch" : "terminal").font(.caption2)
            MonoPath(text: item.rowName, size: .caption)
            if let badge = RowBadge.of(item) {
                Text("· \(badge.word)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
            }
        }
    }
}

struct AgentsInline: View {
    let entry: GlanceEntry

    private var prefix: String {
        if entry.showsServerName, let s = entry.server { return "Optio · \(s.shortName)" }
        return "Optio"
    }

    var body: some View {
        switch entry.reachability {
        case .signedOut: Text("Optio · sign in")
        case .unreachable where entry.count == 0: Text("\(prefix) · unreachable")
        default:
            if let head = entry.needsYou.first {
                let word = RowBadge.of(head)?.word ?? "needs you"
                Text(entry.count > 1 ? "\(prefix) · \(head.rowName) \(word) +\(entry.count - 1)" : "\(prefix) · \(head.rowName) \(word)")
            } else if !entry.running.isEmpty {
                Text("\(prefix) · \(entry.running.count) working")
            } else {
                Text("\(prefix) · quiet")
            }
        }
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Medium", as: .systemMedium) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.partial; GlanceFixtures.offline; GlanceFixtures.stale; GlanceFixtures.signedOut
}
#Preview("Large", as: .systemLarge) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Circular", as: .accessoryCircular) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.signedOut
}
#Preview("Rectangular", as: .accessoryRectangular) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Inline", as: .accessoryInline) { AgentsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
