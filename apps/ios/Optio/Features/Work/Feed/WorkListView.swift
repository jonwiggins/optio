import SwiftUI

/// The one list (`apps/web/src/app/sessions/page.tsx`). Every kind of work — PR
/// tasks, jobs, automations, terminals, pod sessions, persistent agents — as rows
/// with the same five attributes. Views are saved filters; the default is what's
/// alive right now. Lives inside the Work tab's `NavigationStack`.
struct WorkListView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @State private var model: WorkFeedModel?
    @State private var view: WorkView = .active
    @State private var query = ""
    @State private var showNew = false
    /// The needs-you row the count last jumped to (the next tap goes past it).
    @State private var lastJumped: String?

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
                    .accessibilityLabel("New work")
            }
        }
        .sheet(isPresented: $showNew) { NewWorkSheet() }
        .task {
            if model == nil { model = WorkFeedModel(api: api) }
            consumeView()
            model?.start()
        }
        .onAppear { model?.start() }
        .onDisappear { model?.stop() }
        .onChange(of: router.pendingWorkView) { _, _ in consumeView() }
        .onChange(of: router.pendingNewWork) { _, _ in consumeView() }
        .onReceive(NotificationCenter.default.publisher(for: .optioSessionCreated)) { _ in Task { await model?.refresh() } }
    }

    /// `optio://section/sessions?view=recurring` and the Overview tiles land on a view;
    /// `optio://sessions/new` (the New session control) opens the sheet.
    private func consumeView() {
        if let pending = router.pendingWorkView {
            router.pendingWorkView = nil
            withAnimation(.snappy) { view = pending }
        }
        if router.pendingNewWork {
            router.pendingNewWork = false
            showNew = true
        }
    }

    @ViewBuilder
    private func content(_ model: WorkFeedModel) -> some View {
        let visible = model.rows(in: view, query: query)
        let counts = model.counts
        ScrollViewReader { proxy in
            List {
                Section {
                    ChipPicker(options: WorkView.allCases.map { ($0, "\($0.label) \(model.count(in: $0))") }, selection: $view)
                        .listRowInsets(EdgeInsets())
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                    countsLine(counts) { jumpToNeedsYou(model, proxy) }
                        .listRowInsets(EdgeInsets(top: 0, leading: Spacing.l, bottom: Spacing.s, trailing: Spacing.l))
                        .listRowBackground(Color.clear)
                        .listRowSeparator(.hidden)
                }

                if let error = model.error {
                    ErrorRow(error: error, what: "work") { Task { await model.refresh() } }
                }

                if model.loading, model.rows.isEmpty {
                    SkeletonRows()
                } else if visible.isEmpty {
                    EmptyState(
                        title: view == .active ? "Nothing needs you right now" : query.isEmpty ? "Nothing here yet" : "Nothing matches",
                        systemImage: "terminal",
                        message: view == .active
                            ? "Running, queued, and waiting work shows up here. Recurring work lives under its own view until it fires."
                            : "Start something — a PR, a chat on your machine, a schedule, or a persistent agent.",
                        actionTitle: query.isEmpty ? "New work" : nil,
                        action: { showNew = true }
                    )
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                } else {
                    ForEach(visible) { row in
                        NavigationLink(value: row.destination) { WorkRowView(row: row) }
                            .id(row.key)
                    }
                }
            }
            .listStyle(.plain)
            .animation(.snappy, value: view)
            .searchable(text: $query, prompt: "Search name, place, agent…")
            .refreshable { await model.refresh() }
        }
    }

    /// Rows keep a stable order (they don't jump as attention flips), so the
    /// "N need you" count is how you find waiting work: each tap scrolls to the
    /// next one, wrapping, switching to Active when this view has none.
    private func jumpToNeedsYou(_ model: WorkFeedModel, _ proxy: ScrollViewProxy) {
        var rows = model.rows(in: view, query: query)
        let switching = !rows.contains { $0.status == .needsYou }
        if switching {
            rows = model.rows(in: .active)
            withAnimation(.snappy) { view = .active; query = "" }
        }
        guard let target = WorkFeed.nextNeedsYou(rows, after: lastJumped) ?? rows.first(where: { $0.status == .needsYou }) else { return }
        lastJumped = target.key
        Task { @MainActor in
            if switching { try? await Task.sleep(for: .milliseconds(150)) }
            withAnimation(.snappy) { proxy.scrollTo(target.key, anchor: .center) }
        }
    }

    /// "2 need you · 3 running · 1 waiting · 4 recurring · 1 agent" (the page header meta).
    private func countsLine(_ c: WorkCounts, jump: @escaping () -> Void) -> some View {
        HStack(spacing: 6) {
            if c.needsYou > 0 {
                Button(action: jump) {
                    Text("\(c.needsYou) need\(c.needsYou == 1 ? "s" : "") you").foregroundStyle(Tone.accent.textStyle).fontWeight(.medium)
                }
                .buttonStyle(.borderless)
                .accessibilityHint("Shows the next one waiting on you")
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
