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
struct WorkWidget: Widget {
    static let kind = WidgetKinds.work

    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: Self.kind, intent: GlanceConfigurationIntent.self, provider: GlanceTimelineProvider(includeTasks: true)) { entry in
            WorkWidgetView(entry: entry)
                .containerBackground(for: .widget) { GlanceBackground() }
        }
        .configurationDisplayName("Work")
        .description("What needs you, what's running, and the rest of the board. Tap a row to jump in.")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

struct WorkWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: GlanceEntry

    var body: some View {
        switch family {
        case .accessoryCircular: SessionsCircular(entry: entry)
        case .accessoryRectangular: SessionsRectangular(entry: entry)
        case .accessoryInline: SessionsInline(entry: entry)
        case .systemMedium: WorkBoard(entry: entry, budget: 2, expandedRows: false)
        case .systemLarge: WorkBoard(entry: entry, budget: 6, expandedRows: true)
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
    var boardLink: URL { DeepLink.work(view: "active").url }

    /// The head session: oldest needs-you, else newest running.
    var headSession: WatchItem? { sessionRows.first }
    /// Where a tap on an accessory lands: the head session, else the board.
    var headLink: URL { headSession.flatMap { URL(string: $0.link) } ?? boardLink }
}

// MARK: - Home screen

/// The number that matters and the head session: `3 need you`, then `● name` over its
/// status and wait. The whole widget opens the Sessions list.
struct SessionsSmall: View {
    let entry: GlanceEntry

    var body: some View {
        Group {
            if entry.reachability == .signedOut {
                SignedOutView()
            } else {
                ViewThatFits(in: .vertical) {
                    content(showsStatus: true)
                    content(showsStatus: false)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .widgetURL(entry.boardLink)
            }
        }
        .glanceTypeClamp()
    }

    private func content(showsStatus: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text("Work").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                Spacer(minLength: 2)
                Image(systemName: entry.reachability == .unreachable ? "wifi.slash" : "circle.hexagongrid")
                    .font(.caption).foregroundStyle(.secondary).accessibilityHidden(true)
            }
            if let headline = GlanceCopy.headlineCount(needsYou: entry.needsYouCount, running: entry.runningCount) {
                VStack(alignment: .leading, spacing: 0) {
                    CountText(count: headline.count, style: .system(showsStatus ? .largeTitle : .title, design: .rounded).weight(.semibold),
                              color: entry.needsYouCount > 0 ? GlanceStyle.needsYou : GlanceStyle.working)
                    Text(headline.noun).font(.caption.weight(.medium)).foregroundStyle(.secondary)
                }
            } else {
                Image(systemName: entry.reachability == .unreachable ? "wifi.slash" : "checkmark.circle")
                    .font(.largeTitle.weight(.light)).foregroundStyle(entry.reachability == .unreachable ? Color.secondary : StatusColor.green)
                Text(entry.reachability == .unreachable ? "Offline" : "All clear").font(.headline)
            }
            Spacer(minLength: 0)
            if let head = entry.headSession {
                HStack(spacing: 5) {
                    WhoGlyph(item: head, size: 12, colored: true).accessibilityHidden(true)
                    Text(head.rowName).font(.caption.weight(.semibold)).foregroundStyle(Color.primary).lineLimit(1)
                    if entry.isMulti, let tag = ServerTag(item: head) { tag.dot() }
                }
                if showsStatus {
                    HStack(spacing: 5) {
                        StatusBadge(item: head)
                        Text(GlancePolicy.waitText(since: head.since, now: entry.date))
                            .font(.caption2.monospacedDigit()).foregroundStyle(Color.secondary).fixedSize()
                    }
                }
            } else if entry.reachability != .unreachable {
                Text("No active work").font(.caption).foregroundStyle(.secondary)
            }
            HonestyFooter(entry: entry)
        }
    }
}

/// Medium and large: the board tiles (they carry the counts), then as many session rows
/// as the height holds, up to `budget`, then `+N more` and the server / freshness note.
struct WorkBoard: View {
    let entry: GlanceEntry
    let budget: Int
    var expandedRows = false

    var body: some View {
        Group {
            if entry.reachability == .signedOut {
                SignedOutView()
            } else {
                // The most rows that fit the family at this text size: a 4.7" phone's
                // large widget holds fewer than a Pro Max's.
                ViewThatFits(in: .vertical) {
                    ForEach(Array(stride(from: max(budget, 1), through: 1, by: -1)), id: \.self) { n in
                        board(rows: n)
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
        }
        .widgetURL(entry.reachability == .signedOut ? DeepLink.section("more").url : entry.boardLink)
        .glanceTypeClamp()
    }

    private func board(rows limit: Int) -> some View {
        let rows = entry.sessionRows
        let shown = Array(rows.prefix(limit))
        let overflow = rows.count - shown.count
        return VStack(alignment: .leading, spacing: expandedRows ? 12 : 8) {
            if expandedRows {
                HStack {
                    Text("Work").font(.subheadline.weight(.semibold))
                    Spacer()
                    Link(destination: DeepLink.newWork.url) {
                        Image(systemName: "plus").font(.caption.weight(.semibold))
                            .foregroundStyle(Color.secondary).frame(width: 26, height: 26)
                            .background(.fill.tertiary, in: Circle())
                    }
                    .accessibilityLabel("New work")
                }
                TileStrip(tiles: entry.tiles)
                Divider().opacity(0.6)
                sessionList(shown)
            } else {
                HStack(alignment: .top, spacing: 14) {
                    VStack(alignment: .leading, spacing: 6) {
                        let headline = GlanceCopy.headlineCount(needsYou: entry.needsYouCount, running: entry.runningCount)
                        GlanceMetric(count: headline?.count ?? 0, label: headline?.noun ?? "active", color: entry.needsYouCount > 0 ? GlanceStyle.needsYou : GlanceStyle.working)
                        if entry.needsYouCount > 0 {
                            Label("\(entry.runningCount) running", systemImage: "circle.dotted")
                                .font(.caption2).foregroundStyle(entry.runningCount > 0 ? GlanceStyle.working : Color.secondary).fixedSize()
                        } else {
                            Text("Work").font(.caption2.weight(.medium)).foregroundStyle(.secondary)
                        }
                    }
                    .frame(width: 86, alignment: .leading)
                    Rectangle().fill(Color(uiColor: .separator)).frame(width: 0.5)
                    sessionList(shown).frame(maxWidth: .infinity, alignment: .topLeading)
                }
                .fixedSize(horizontal: false, vertical: true)
                SavedWorkCounts(tiles: entry.tiles)
            }
            BoardFooter(entry: entry, overflow: overflow)
        }
    }

    private func sessionList(_ rows: [WatchItem]) -> some View {
        VStack(alignment: .leading, spacing: expandedRows ? 10 : 8) {
            if rows.isEmpty {
                Label(entry.reachability == .unreachable ? "Last update unavailable" : "You're all caught up", systemImage: entry.reachability == .unreachable ? "wifi.slash" : "checkmark.circle")
                    .font(.subheadline.weight(.medium)).foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .leading)
            } else {
                ForEach(rows) { item in
                    SessionGlanceRow(item: item, now: entry.date, showsServer: entry.isMulti, showsLater: expandedRows, expanded: expandedRows)
                }
            }
        }
    }
}

/// `+2 more` on the left, the server name (when others are paired) and the freshness
/// note on the right. Nothing when there is nothing to say.
struct BoardFooter: View {
    let entry: GlanceEntry
    let overflow: Int

    private var hasNote: Bool {
        entry.reachability == .unreachable || entry.isStale || (entry.isMulti && !entry.unreachableSlices.isEmpty) || entry.showsServerName
    }

    var body: some View {
        if overflow > 0 || hasNote {
            HStack(spacing: 6) {
                if overflow > 0 {
                    Link(destination: entry.boardLink) {
                        Text("+\(overflow) more").font(.caption2.weight(.semibold)).foregroundStyle(Color.secondary).fixedSize()
                    }
                }
                Spacer(minLength: 4)
                if entry.showsServerName, let s = entry.server { ServerTag(s) }
                HonestyFooter(entry: entry)
            }
            .lineLimit(1)
        }
    }
}

// MARK: - Accessories (monochrome by design)

struct SessionsCircular: View {
    let entry: GlanceEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            if entry.reachability == .signedOut {
                Image(systemName: "lock.fill").font(.title3).accessibilityLabel("Sign in to Optio")
            } else if entry.reachability == .unreachable {
                Image(systemName: "wifi.slash").font(.title3).accessibilityLabel("Server unreachable")
            } else if let headline = GlanceCopy.headlineCount(needsYou: entry.needsYouCount, running: entry.runningCount) {
                VStack(spacing: 0) {
                    Image(systemName: entry.needsYouCount > 0 ? "exclamationmark.bubble.fill" : "play.fill")
                        .font(.system(size: 10, weight: .semibold))
                    Text("\(headline.count)")
                        .font(.system(.title2, design: .rounded).weight(.semibold)).monospacedDigit()
                        .contentTransition(.numericText())
                }
                .widgetAccentable()
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("\(headline.count) \(headline.noun)")
            } else {
                Image(systemName: "checkmark").font(.title2.weight(.medium)).accessibilityLabel("All clear")
            }
        }
        .widgetURL(entry.reachability == .signedOut ? DeepLink.section("more").url : entry.headLink)
        .glanceTypeClamp()
    }
}

/// `Needs you +2` / `[who] Allow? · web` / `4m · MacBook Pro · web`, the oldest session
/// only. The status word comes before the name, so only the name ever shortens.
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
                        Text("Needs you").font(.headline).widgetAccentable().fixedSize()
                        if entry.needsYouCount > 1 { Text("+\(entry.needsYouCount - 1)").font(.caption).foregroundStyle(.secondary).fixedSize() }
                    }
                    AccessorySessionLine(item: head)
                    AccessoryWhereLine(item: head, now: entry.date, showsServer: entry.isMulti || entry.showsServerName)
                } else if let head = entry.headSession {
                    HStack(spacing: 4) {
                        Text("Running").font(.headline).fixedSize()
                        if entry.runningCount > 1 { Text("+\(entry.runningCount - 1)").font(.caption).foregroundStyle(.secondary).fixedSize() }
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
        .glanceTypeClamp()
    }
}

/// `[who] Allow? · web` for the lock screen: monochrome, one line, the word whole.
struct AccessorySessionLine: View {
    let item: WatchItem

    var body: some View {
        HStack(spacing: 4) {
            WhoGlyph(item: item, size: 10)
            Text(item.statusWord).font(.caption.weight(.semibold)).lineLimit(1).fixedSize()
            Text("· \(item.rowName)").font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
        }
    }
}

/// `4m · MacBook Pro · web`: the wait, then the Where as long as it fits whole.
struct AccessoryWhereLine: View {
    let item: WatchItem
    let now: Date
    var showsServer = false

    var body: some View {
        let place = item.whereValue
        var options = GlanceCopy.whereOptions(place.detail, target: place.target.rawValue)
        if showsServer, let name = item.serverName, place.detail == nil { options = options.map { "\($0) · \(name)" } }
        return HStack(spacing: 4) {
            Text(GlancePolicy.waitText(since: item.since, now: now)).fixedSize()
            Image(systemName: place.systemImage).font(.caption2)
            ViewThatFits(in: .horizontal) {
                ForEach(options, id: \.self) { Text($0).lineLimit(1).fixedSize() }
                Text(options.last ?? "").lineLimit(1).truncationMode(.middle)
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
        Group {
            switch entry.reachability {
            case .signedOut: Text("Optio · sign in")
            case .unreachable where entry.needsYouCount == 0: Text("\(prefix) · unreachable")
            default:
                let head = entry.headSession.flatMap { $0.waitsOnYou ? $0 : nil }
                Text(GlanceCopy.inline(prefix: prefix, headName: head?.rowName, headWord: head?.statusWord,
                                       needsYou: entry.needsYouCount, running: entry.runningCount))
            }
        }
        .glanceTypeClamp()
    }
}

// MARK: - Previews

#Preview("Small", as: .systemSmall) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Medium", as: .systemMedium) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.legacy; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.partial; GlanceFixtures.offline; GlanceFixtures.stale; GlanceFixtures.signedOut
}
#Preview("Large", as: .systemLarge) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.single; GlanceFixtures.quiet; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Circular", as: .accessoryCircular) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.signedOut
}
#Preview("Rectangular", as: .accessoryRectangular) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
#Preview("Inline", as: .accessoryInline) { WorkWidget() } timeline: {
    GlanceFixtures.waiting; GlanceFixtures.one; GlanceFixtures.quiet; GlanceFixtures.idle; GlanceFixtures.offline; GlanceFixtures.signedOut
}
