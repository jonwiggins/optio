import SwiftUI

/// "Live" tab: Local (Optio Local terminals on the user's own machine, first and
/// default) · Agents (persistent agents) · Sessions (interactive workspaces).
struct LiveHubView: View {
    enum Section: Hashable { case local, agents, sessions }
    @State private var section: Section = .local
    @State private var path = NavigationPath()
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack(path: $path) {
            VStack(spacing: 0) {
                HubSwitcher(options: [(Section.local, "Local"), (.agents, "Agents"), (.sessions, "Sessions")], selection: $section)
                Group {
                    switch section {
                    case .local: LocalHubView()
                    case .agents: AgentsListView()
                    case .sessions: SessionsListView()
                    }
                }
                .id(section)
            }
            .navigationTitle("Live")
            .hubChrome()
            .navigationDestination(for: AppRouter.PendingDetail.self) { detail in
                switch detail.kind {
                case .local: LocalTerminalScreen(terminalId: detail.id, focusComposer: detail.compose)
                case .agent: AgentDetailView(agentId: detail.id, focusComposer: detail.compose)
                case .session: SessionDetailView(sessionId: detail.id)
                case .task: TaskDetailView(taskId: detail.id)
                }
            }
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
            .onChange(of: router.pendingDetail) { _, _ in consumeRoute() }
        }
    }

    /// Cross-tab deep link from `AppRouter.open(_:)`.
    private func consumeRoute() {
        guard let pending = router.pendingSection else { return }
        let mapped: Section? = switch pending {
        case .agents: .agents
        case .sessions: .sessions
        case .local: .local
        default: nil
        }
        guard let mapped else { return }
        section = mapped
        router.pendingSection = nil
        consumeDetail()
    }

    /// `optio://local/<id>?compose=1`, `optio://agents/<id>?compose=1`, `optio://sessions/<id>`:
    /// replace the stack with the detail so the deep link lands in one hop.
    private func consumeDetail() {
        guard let detail = router.pendingDetail, detail.kind != .task else { return }
        router.pendingDetail = nil
        path = NavigationPath([detail])
    }
}
