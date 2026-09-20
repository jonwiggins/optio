import SwiftUI

/// The "Work" tab: Sessions · Reviews · Inbox, matching the web sidebar group.
/// One large title; the section switcher lives under it and each section owns
/// its own list → detail flow inside this stack. The per-kind detail screens
/// (task, job run, agent, local terminal, pod session) are destinations of
/// Sessions rows, not sections of their own.
struct WorkHubView: View {
    enum Section: String, CaseIterable { case sessions, reviews, inbox }
    @State private var section: Section = .sessions
    @State private var path = NavigationPath()
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                HubSwitcher(options: [(Section.sessions, "Sessions"), (.reviews, "Reviews"), (.inbox, "Inbox")], selection: $section)
                Group {
                    switch section {
                    case .sessions: SessionsView()
                    case .reviews: ReviewsListView()
                    case .inbox: IssuesListView()
                    }
                }
                .id(section)
            }
            .navigationTitle("Work")
            .hubChrome()
            .serverSwitcherToolbar()
            .sessionDestinations()
            .navigationDestination(for: AppRouter.PendingDetail.self) { detail in
                switch detail.kind {
                case .task: TaskDetailView(taskId: detail.id, focusComposer: detail.compose)
                case .local: LocalTerminalScreen(terminalId: detail.id, focusComposer: detail.compose)
                case .agent: AgentDetailView(agentId: detail.id, focusComposer: detail.compose)
                case .session: SessionDetailView(sessionId: detail.id)
                }
            }
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
            .onChange(of: router.pendingDetail) { _, _ in consumeRoute() }
            .onChange(of: router.createdSession) { _, _ in consumeCreated() }
            .toast(router.createdToast, tone: .success) { router.createdToast = nil }
        }
    }

    /// The New session form just made something: push its detail screen.
    private func consumeCreated() {
        guard let destination = router.createdSession else { return }
        router.createdSession = nil
        path.append(destination)
    }

    /// Cross-tab deep link from `AppRouter.open(_:)`.
    private func consumeRoute() {
        guard let pending = router.pendingSection else { return }
        let mapped: Section? = switch pending {
        case .sessions: .sessions
        case .reviews: .reviews
        case .inbox: .inbox
        default: nil
        }
        guard let mapped else { return }
        section = mapped
        router.pendingSection = nil
        consumeDetail()
        consumeCreated()
    }

    /// `optio://tasks/<id>`, `optio://local/<id>?compose=1`, `optio://agents/<id>?compose=1`,
    /// `optio://sessions/<id>` (widgets, Live Activity, notifications): replace the
    /// stack with the detail so the deep link lands in one hop.
    private func consumeDetail() {
        guard let detail = router.pendingDetail else { return }
        router.pendingDetail = nil
        path = NavigationPath([detail])
    }
}
