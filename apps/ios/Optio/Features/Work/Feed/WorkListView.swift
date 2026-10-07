import SwiftUI

/// The one list (`apps/web/src/app/sessions/page.tsx`). Every kind of work — PR
/// tasks, jobs, automations, terminals, pod sessions, persistent agents — as rows
/// with the same five attributes. Views are saved filters; the default is what's
/// alive right now. Lives inside the Work tab's `NavigationStack`.
struct WorkListView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(SessionStore.self) private var session
    @State private var model: WorkFeedModel?
    @State private var view: WorkView = .active
    @State private var query = ""
    @State private var focus: WorkStatus?
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
            // Viewers are read-only: no "+" (Android hides it too).
            if session.canCreateWork {
                ToolbarItem(placement: .primaryAction) {
                    Button { showNew = true } label: { Image(systemName: "plus") }
                        .accessibilityLabel("New work")
                }
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
            withAnimation(.snappy) { view = pending; focus = nil }
        }
        if router.pendingNewWork {
            router.pendingNewWork = false
            // `optio://work/new` from a widget or control: a viewer lands on the list.
            if session.canCreateWork { showNew = true }
        }
    }

    @ViewBuilder
    private func content(_ model: WorkFeedModel) -> some View {
        let visible = model.rows(in: view, query: query).filter { focus == nil || $0.status == focus }
        let counts = model.counts
        List {
            Section {
                ChipPicker(options: WorkView.allCases.map { ($0, "\($0.label) \(model.count(in: $0))") }, selection: Binding(get: { view }, set: { view = $0; focus = nil }), horizontalPadding: 0)
                    .listRowInsets(EdgeInsets())
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
                HStack(spacing: Spacing.s) {
                    focusTile("Needs you", count: counts.needsYou, status: .needsYou, tone: .accent)
                    focusTile("Running", count: counts.running, status: .running, tone: .working)
                    focusTile("Ready", count: counts.waiting, status: .waiting, tone: .success)
                }
                .listRowInsets(EdgeInsets(top: Spacing.s, leading: 0, bottom: 0, trailing: 0))
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            if let error = model.error {
                ErrorRow(error: error, what: "work") { Task { await model.refresh() } }
            }

            if model.loading, model.rows.isEmpty {
                SkeletonRows()
            } else if visible.isEmpty, model.error == nil {
                EmptyState(
                    title: !query.isEmpty || focus != nil ? "No matching work" : view == .active ? "You’re all caught up" : "Nothing here yet",
                    systemImage: "terminal",
                    message: !query.isEmpty || focus != nil ? "Try another view or clear your filters." : view == .active
                        ? "Running, queued, and waiting work shows up here. Recurring work lives under its own view until it fires."
                        : "Start something — a PR, a chat on your machine, a schedule, or a persistent agent.",
                    actionTitle: !query.isEmpty || focus != nil ? "Clear filters" : session.canCreateWork ? "New work" : nil,
                    action: { if !query.isEmpty || focus != nil { query = ""; focus = nil } else { showNew = true } }
                )
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
            } else {
                ForEach(visible) { row in
                    NavigationLink(value: row.destination) { WorkRowView(row: row) }
                        .id(row.key)
                        .listRowBackground(Surface.card)
                        .listRowSeparatorTint(Surface.border)
                }
            }
        }
        .listStyle(.insetGrouped)
        .listSectionSpacing(Spacing.m)
        .contentMargins(.top, 0, for: .scrollContent)
        .scrollContentBackground(.hidden)
        .background(Surface.page)
        .animation(.snappy, value: view)
        .searchable(text: $query, prompt: "Search name, place, agent…")
        .refreshable { await model.refresh() }
    }

    private func focusTile(_ label: String, count: Int, status: WorkStatus, tone: Tone) -> some View {
        Button {
            withAnimation(.snappy) {
                let next: WorkStatus? = focus == status ? nil : status
                view = .active
                focus = next
            }
        } label: {
            VStack(alignment: .leading, spacing: Spacing.xs) {
                Text("\(count)").font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(count > 0 ? tone.textStyle : AnyShapeStyle(AppTheme.secondaryText))
                Text(label).font(.caption.weight(.medium)).foregroundStyle(AppTheme.secondaryText)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(Spacing.m)
            .background(focus == status ? AppTheme.accent.opacity(0.08) : Surface.card, in: Radius.cardShape)
            .overlay { Radius.cardShape.strokeBorder(focus == status ? AppTheme.accent : Surface.border, lineWidth: 1) }
        }
        .buttonStyle(.plain)
        .accessibilityLabel("\(label): \(count)")
        .accessibilityAddTraits(focus == status ? .isSelected : [])
    }
}
