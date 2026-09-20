import SwiftUI

/// The one list (`apps/web/src/app/sessions/page.tsx`). Every kind of work — PR
/// tasks, jobs, automations, terminals, pod sessions, persistent agents — as rows
/// with the same five attributes. Views are saved filters; the default is what's
/// alive right now. Lives inside the Work tab's `NavigationStack`.
struct SessionsView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @State private var model: SessionsFeedModel?
    @State private var view: SessionView = .active
    @State private var query = ""
    @State private var showNew = false

    var body: some View {
        Group {
            if let model {
                content(model)
            } else {
                List { SkeletonRows() }.listStyle(.plain)
            }
        }
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button { showNew = true } label: { Image(systemName: "plus") }
                    .accessibilityLabel("New session")
            }
            ToolbarItem(placement: .secondaryAction) {
                Menu {
                    ForEach(SessionBrowseRoute.allCases, id: \.self) { route in
                        NavigationLink(value: route) { Label(route.label, systemImage: route.systemImage) }
                    }
                } label: {
                    Label("Browse by kind", systemImage: "square.grid.2x2")
                }
            }
        }
        .sheet(isPresented: $showNew) { NewSessionSheet() }
        .task {
            if model == nil { model = SessionsFeedModel(api: api) }
            consumeView()
            model?.start()
        }
        .onAppear { model?.start() }
        .onDisappear { model?.stop() }
        .onChange(of: router.pendingSessionView) { _, _ in consumeView() }
        .onChange(of: router.pendingNewSession) { _, _ in consumeView() }
        .onReceive(NotificationCenter.default.publisher(for: .optioSessionCreated)) { _ in Task { await model?.refresh() } }
    }

    /// `optio://section/sessions?view=recurring` and the Overview tiles land on a view;
    /// `optio://sessions/new` (the New session control) opens the sheet.
    private func consumeView() {
        if let pending = router.pendingSessionView {
            router.pendingSessionView = nil
            withAnimation(.snappy) { view = pending }
        }
        if router.pendingNewSession {
            router.pendingNewSession = false
            showNew = true
        }
    }

    @ViewBuilder
    private func content(_ model: SessionsFeedModel) -> some View {
        let visible = model.rows(in: view, query: query)
        let counts = model.counts
        List {
            Section {
                ChipPicker(options: SessionView.allCases.map { ($0, "\($0.label) \(model.count(in: $0))") }, selection: $view)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                countsLine(counts)
                    .listRowInsets(EdgeInsets(top: 0, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }

            if let error = model.error {
                ErrorRow(error: error, what: "sessions") { Task { await model.refresh() } }
            }

            if model.loading, model.rows.isEmpty {
                SkeletonRows()
            } else if visible.isEmpty {
                EmptyState(
                    title: view == .active ? "Nothing needs you right now" : query.isEmpty ? "No sessions here yet" : "No sessions match",
                    systemImage: "terminal",
                    message: view == .active
                        ? "Running, queued, and waiting sessions show up here. Recurring ones live under their own view until they fire."
                        : "Start something — a PR, a chat on your machine, a schedule, or a persistent agent.",
                    actionTitle: query.isEmpty ? "New session" : nil,
                    action: { showNew = true }
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                ForEach(visible) { row in
                    NavigationLink(value: row.destination) { SessionRowView(row: row) }
                }
            }
        }
        .listStyle(.plain)
        .animation(.snappy, value: view)
        .searchable(text: $query, prompt: "Search name, place, agent…")
        .refreshable { await model.refresh() }
    }

    /// "2 need you · 3 running · 1 waiting · 4 recurring · 1 agent" (the page header meta).
    private func countsLine(_ c: SessionCounts) -> some View {
        HStack(spacing: 6) {
            if c.needsYou > 0 {
                Text("\(c.needsYou) need\(c.needsYou == 1 ? "s" : "") you").foregroundStyle(Tone.accent.textStyle)
                Text("·").foregroundStyle(.tertiary)
            }
            Text("\(c.running) running · \(c.waiting) waiting · \(c.recurring) recurring · \(c.agents) agent\(c.agents == 1 ? "" : "s")")
                .foregroundStyle(.secondary)
        }
        .font(.footnote)
        .contentTransition(.numericText())
        .lineLimit(1)
        .minimumScaleFactor(0.8)
    }
}
