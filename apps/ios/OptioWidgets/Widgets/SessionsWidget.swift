import SwiftUI
import WidgetKit

/// "Sessions": the one status widget, a slice of the app's Sessions board. Small shows
/// the number that matters (needs you, else running) and the head session with its
/// Where; medium the five board tiles and the top two active sessions; large the tiles
/// and up to six sessions as two-line rows (name · status, then the When / Where / Who
/// / Then chips). Lock-screen families show the oldest needs-you session.
///
/// Configurable per server: left empty it shows every paired server, with a coloured
/// server dot on each row instead of sections, so rows keep their width.
///
/// Keeps the original "Needs You" kind id so widgets already on a home screen survive
/// the rename (Needs You → Agents → Sessions).
struct SessionsWidget: Widget {
    static let kind = WidgetKinds.sessions

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: GlanceConfigurationIntent.self, provider: GlanceTimelineProvider(includeTasks: true)) { entry in
            SessionsView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Sessions")
        .description("What needs you, what's running, and the rest of the board. Tap a session to jump in.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct SessionsView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryCircular: SessionsCircular(entry: entry)
        case .accessoryRectangular: SessionsRectangular(entry: entry)
        case .accessoryInline: SessionsInline(entry: entry)
        case .systemMedium: SessionsBoard(entry: entry, budget: 2, expandedRows: false)
        case .systemLarge: SessionsBoard(entry: entry, budget: 6, expandedRows: true)
        default: SessionsSmall(entry: entry)
        }
    }
}

// MARK: - Rows

extension GlanceEntry {
    /// Repo Tasks in flight that are not already rows (followed tasks join the snapshot),
    /// as session rows with the four attributes.
    var taskRows: [WatchItem] {
        let seen = Set((needsYou + running).map(\.id))
        return tasks.filter { !seen.contains($0.id) }.map { t in
            let reason: String? = switch t.prChecksStatus {
            case "failing": "CI failing"
            case "passing": "CI passed"
            default: nil
            }
            let local = t.runTarget == "local"
            return WatchItem(kind: .task, id: t.id, title: t.title, mono: t.branch.isEmpty ? (t.prNumber.map { "#\($0)" } ?? t.title) : t.branch,
                             reason: reason, since: t.since == .distantPast ? date : t.since, state: t.state,
                             link: DeepLink.task(t.id).url(server: t.serverId).absoluteString, prUrl: t.prUrl,
                             serverId: t.serverId, serverName: t.serverName,
                             source: .repoTask, when: "now",
                             where: local ? WatchWhere(target: .machine, detail: t.localDir.map(NeedsYouSnapshot.shortDir))
                                          : WatchWhere(target: .pod, detail: NeedsYouSnapshot.shortRepo(t.repoUrl)),
                             who: t.agentType ?? "claude-code", then: .exits,
                             statusLabel: NeedsYouSnapshot.taskStatusLabel(t.state))
        }
    }

    /// Every active session the widget knows, ranked like the app: needs-you (oldest
    /// first, snoozed last), then running (newest first), then waiting at an open PR.
    var sessionRows: [WatchItem] {
        let extra = taskRows
        let needs = needsYou + extra.filter(\.waitsOnYou)
        let live = (running + extra.filter { !$0.waitsOnYou && $0.state != "pr_opened" }).sorted { $0.since > $1.since }
        let waiting = extra.filter { !$0.waitsOnYou && $0.state == "pr_opened" }
        return needs + live + waiting
    }

    /// Board numbers: needs-you and running from the rows, the rest from the server.
    var needsYouCount: Int { sessionRows.filter(\.waitsOnYou).count }
    var runningCount: Int { sessionRows.filter { !$0.waitsOnYou && $0.state != "pr_opened" }.count }
    var tiles: [GlanceCopy.Tile] {
        GlanceCopy.tiles(needsYou: needsYouCount, running: runningCount,
                         waiting: tileCounts?.waiting, recurring: tileCounts?.recurring, agents: tileCounts?.agents)
    }

    /// Where a tap on the widget chrome lands: the Sessions list, Active view.
    var boardLink: URL { DeepLink.sessions(view: "active").url }

    /// The head session: oldest needs-you, else newest running.
    var headSession: WatchItem? { sessionRows.first }
    /// Where a tap on an accessory lands: the head session, else the board.
    var headLink: URL { headSession.flatMap { URL(string: $0.link) } ?? boardLink }
}

// MARK: - Header

/// `[bot] 3 need you · 2 running [server]      [footer]`, or `Quiet` when nothing is on.
struct SessionsHeader: View {
    let entry: GlanceEntry

    var body: some View {
        HStack(spacing: 5) {
            GlanceStyle.headerGlyph(needsYou: entry.needsYouCount)
            let needs = entry.needsYouCount
            let running = entry.runningCount
            if needs > 0 {
                Text("\(needs)").foregroundStyle(GlanceStyle.needsYou).contentTransition(.numericText()).widgetAccentable()
                Text(needs == 1 ? "needs you" : "need you").foregroundStyle(.secondary)
            }
            if running > 0 {
                if needs > 0 { Text("·").foregroundStyle(.tertiary) }
                Text("\(running)").foregroundStyle(GlanceStyle.working).contentTransition(.numericText())
                Text("running").foregroundStyle(.secondary)
            }
            if needs == 0, running == 0 {
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

/// The number that matters on top, the head session and its Where underneath, so the
/// count is never a dead end. The whole widget opens the Sessions list.
struct SessionsSmall: View {
    let entry: GlanceEntry

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    GlanceStyle.headerGlyph(needsYou: entry.needsYouCount, size: 18)
                    if entry.showsServerName, let s = entry.server {
                        ServerTag(s)
                    } else if entry.isMulti {
                        Text("\(entry.slices.count) servers").font(.caption2.weight(.semibold)).foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 0)
                    HonestyFooter(entry: entry)
                }
                Spacer(minLength: 0)
                if let headline = GlanceCopy.headlineCount(needsYou: entry.needsYouCount, running: entry.runningCount) {
                    CountText(count: headline.count, color: entry.needsYouCount > 0 ? GlanceStyle.needsYou : GlanceStyle.working)
                    Text(headline.noun).font(.footnote.weight(.medium)).foregroundStyle(.secondary)
                } else {
                    Text("Quiet").font(.title.weight(.semibold)).foregroundStyle(.secondary)
                    Text("no sessions running").font(.footnote).foregroundStyle(.tertiary)
                }
                if let head = entry.headSession {
                    let place = head.whereValue
                    VStack(alignment: .leading, spacing: 1) {
                        HStack(spacing: 5) {
                            StateDotView(state: head.state, size: 6)
                            Text(head.rowName).font(.footnote.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
                            if entry.isMulti, let tag = ServerTag(item: head) { tag.dot() }
                        }
                        SessionChip(systemImage: place.systemImage, label: GlanceCopy.whereLabel(place.detail, target: place.target.rawValue, short: true), mono: true)
                            .padding(.leading, 11)
                    }
                    .padding(.top, 2)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            .widgetURL(entry.boardLink)
        }
    }
}

/// Medium and large: header, the board tiles, then session rows within a budget.
struct SessionsBoard: View {
    let entry: GlanceEntry
    let budget: Int
    var expandedRows = false

    var body: some View {
        if entry.reachability == .signedOut {
            SignedOutView()
        } else {
            let rows = entry.sessionRows
            let shown = Array(rows.prefix(budget))
            let overflow = rows.count - shown.count
            VStack(alignment: .leading, spacing: expandedRows ? 6 : 5) {
                SessionsHeader(entry: entry)
                TileStrip(tiles: entry.tiles, compact: !expandedRows)
                if rows.isEmpty {
                    Spacer(minLength: 0)
                    HStack(spacing: 6) {
                        Image(systemName: entry.reachability == .unreachable ? "wifi.slash" : "moon.zzz")
                        Text(entry.reachability == .unreachable ? "Unreachable" : "No sessions running")
                    }
                    .font(.footnote).foregroundStyle(.tertiary)
                    .frame(maxWidth: .infinity)
                    Spacer(minLength: 0)
                } else {
                    ForEach(shown) { item in
                        SessionGlanceRow(item: item, now: entry.date, showsServer: entry.isMulti, showsLater: expandedRows, expanded: expandedRows)
                    }
                    if overflow > 0 {
                        Link(destination: entry.boardLink) {
                            Text("+\(overflow) more").font(.caption2.weight(.semibold)).foregroundStyle(Color(.tertiaryLabel))
                        }
                    }
                }
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        }
    }
}

// MARK: - Accessories (monochrome by design)

struct SessionsCircular: View {
    let entry: GlanceEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Circle().strokeBorder(.primary.opacity(entry.needsYouCount > 0 ? 1 : 0.35), lineWidth: 3)
            if entry.reachability == .signedOut {
                OptioGlyph(size: 16, style: .primary)
            } else if let headline = GlanceCopy.headlineCount(needsYou: entry.needsYouCount, running: entry.runningCount) {
                Text("\(headline.count)")
                    .font(.system(.title3, design: .rounded).weight(entry.needsYouCount > 0 ? .bold : .semibold))
                    .foregroundStyle(entry.needsYouCount > 0 ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
                    .contentTransition(.numericText())
                    .widgetAccentable(entry.needsYouCount > 0)
            }
        }
        .widgetURL(entry.headLink)
    }
}

/// `Needs you +2` / `[who] web · Allow?` / `4m · MacBook · web`, the oldest session only.
struct SessionsRectangular: View {
    let entry: GlanceEntry

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            switch entry.reachability {
            case .signedOut:
                Text("Optio").font(.headline)
                Text("Sign in").font(.caption).foregroundStyle(.secondary)
            case .unreachable where entry.needsYouCount == 0:
                Text("Optio").font(.headline)
                Label(entry.unreachableSince.map(GlanceStyle.time) ?? "Unreachable", systemImage: "wifi.slash").font(.caption)
            default:
                if let head = entry.headSession, head.waitsOnYou {
                    HStack(spacing: 4) {
                        Text("Needs you").font(.headline).widgetAccentable()
                        if entry.needsYouCount > 1 { Text("+\(entry.needsYouCount - 1)").font(.caption).foregroundStyle(.secondary) }
                    }
                    AccessorySessionLine(item: head)
                    AccessoryWhereLine(item: head, now: entry.date, showsServer: entry.isMulti || entry.showsServerName)
                } else if let head = entry.headSession {
                    HStack(spacing: 4) {
                        Text("Running").font(.headline)
                        if entry.runningCount > 1 { Text("+\(entry.runningCount - 1)").font(.caption).foregroundStyle(.secondary) }
                    }
                    AccessorySessionLine(item: head)
                    AccessoryWhereLine(item: head, now: entry.date, showsServer: entry.isMulti || entry.showsServerName)
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

/// `[who] name · Word` for the lock screen: monochrome, one line.
struct AccessorySessionLine: View {
    let item: WatchItem

    var body: some View {
        HStack(spacing: 4) {
            WhoGlyph(item: item, size: 10)
            MonoPath(text: item.rowName, size: .caption)
            Text("· \(item.statusWord)").font(.caption).foregroundStyle(.secondary).lineLimit(1)
        }
    }
}

/// `4m · MacBook · web`: wait, then the Where chip (host and leaf).
struct AccessoryWhereLine: View {
    let item: WatchItem
    let now: Date
    var showsServer = false

    var body: some View {
        let place = item.whereValue
        HStack(spacing: 4) {
            Text(GlancePolicy.waitText(since: item.since, now: now))
            Image(systemName: place.systemImage).font(.caption2)
            Text(GlanceCopy.whereLabel(place.detail, target: place.target.rawValue, short: true)).lineLimit(1)
            if showsServer, let name = item.serverName, place.detail == nil {
                Text("· \(name)").lineLimit(1)
            }
        }
        .font(.caption).foregroundStyle(.secondary)
    }
}

struct SessionsInline: View {
    let entry: GlanceEntry

    private var prefix: String {
        if entry.showsServerName, let s = entry.server { return "Optio · \(s.shortName)" }
        return "Optio"
    }

    var body: some View {
        switch entry.reachability {
        case .signedOut: Text("Optio · sign in")
        case .unreachable where entry.needsYouCount == 0: Text("\(prefix) · unreachable")
        default:
            let head = entry.headSession.flatMap { $0.waitsOnYou ? $0 : nil }
            Text(GlanceCopy.inline(prefix: prefix, headName: head?.rowName, headWord: head?.statusWord,
                                   needsYou: entry.needsYouCount, running: entry.runningCount))
        }
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Medium", as: .systemMedium) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.legacy; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.partial; GlanceFixtures.offline; GlanceFixtures.stale; GlanceFixtures.signedOut
}
#Preview("Large", as: .systemLarge) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Circular", as: .accessoryCircular) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.signedOut
}
#Preview("Rectangular", as: .accessoryRectangular) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Inline", as: .accessoryInline) { SessionsWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
