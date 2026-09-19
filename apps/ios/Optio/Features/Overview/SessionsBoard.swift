import SwiftUI

/// The overview's centre: one board over the unified sessions feed
/// (`dashboard/sessions-board.tsx`). Five tiles (each a saved view of the
/// Sessions list), then what's alive right now, then the recurring and
/// persistent sessions that will wake on their own. Emits `List` sections, so
/// it sits inside the Overview's grouped list.
struct SessionsBoardSections: View {
    let feed: SessionsFeedModel
    var onNewSession: () -> Void
    @Environment(AppRouter.self) private var router

    private var counts: SessionCounts { feed.counts }
    private var active: [SessionRow] { Array(feed.rows(in: .active).prefix(8)) }
    private var recurring: [SessionRow] { Array(feed.rows(in: .recurring).prefix(5)) }
    private var agents: [SessionRow] { Array(feed.rows(in: .agents).prefix(5)) }
    private var placeholder: Bool { feed.loading && feed.rows.isEmpty }

    var body: some View {
        Section {
            if placeholder {
                SkeletonStrip(labels: ["Need you", "Running", "Waiting", "Recurring", "Agents"])
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
            } else {
                StatStrip(items: [
                    StatItem("Need you", counts.needsYou, tone: .accent, key: "active"),
                    StatItem("Running", counts.running, key: "running"),
                    StatItem("Waiting", counts.waiting, key: "waiting"),
                    StatItem("Recurring", counts.recurring, key: "recurring"),
                    StatItem("Agents", counts.agents, key: "agents"),
                ]) { item in
                    switch item.key {
                    case "recurring": router.openSessions(.recurring)
                    case "agents": router.openSessions(.agents)
                    default: router.openSessions(.active)
                    }
                }
                .listRowInsets(EdgeInsets())
                .listRowBackground(Color.clear)
            }
            if let error = feed.error {
                ErrorRow(error: error, what: "sessions") { Task { await feed.refresh() } }
                    .listRowBackground(Color.clear)
            }
        }

        Section {
            if active.isEmpty {
                Text(placeholder ? "Loading…" : "Nothing running or waiting on you right now.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
                    .padding(.vertical, Spacing.m)
                    .listRowBackground(Color.clear)
            } else {
                ForEach(active) { row in
                    NavigationLink(value: row.destination) { SessionRowView(row: row) }
                }
            }
        } header: {
            // "Active sessions · N          All ›  + New session" (active-sessions.tsx header).
            HStack(spacing: Spacing.m) {
                SectionHeader(title: "Active sessions", detail: active.isEmpty ? nil : "\(feed.count(in: .active))") { router.openSessions(.active) }
                Button(action: onNewSession) {
                    Label("New session", systemImage: "plus")
                        .font(.footnote.weight(.semibold))
                        .foregroundStyle(AppTheme.accent)
                }
                .buttonStyle(.plain)
            }
            .textCase(nil)
        }

        // Recurring and persistent agents sit side by side on the web; stacked here.
        miniList("Recurring", rows: recurring, view: .recurring, empty: "No schedules or event triggers yet.")
        miniList("Persistent agents", rows: agents, view: .agents, empty: "No persistent agents yet.")
    }

    private func miniList(_ title: String, rows: [SessionRow], view: SessionView, empty: String) -> some View {
        Section {
            if rows.isEmpty {
                Text(empty).font(.footnote).foregroundStyle(.secondary).listRowBackground(Color.clear)
            } else {
                ForEach(rows) { row in
                    NavigationLink(value: row.destination) { SessionRowView(row: row) }
                }
            }
        } header: {
            SectionHeader(title: title, detail: "\(feed.count(in: view))") { router.openSessions(view) }.textCase(nil)
        }
    }
}
