import SwiftUI

/// "Live" tab: Agents (persistent agents) · Sessions (interactive workspaces) ·
/// Local (Optio Local terminals on the user's own machine).
struct LiveHubView: View {
    enum Section: Hashable { case agents, sessions, local }
    @State private var section: Section = .agents
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                ChipPicker(options: [
                    (Section.agents, "Agents"),
                    (Section.sessions, "Sessions"),
                    (Section.local, "Local"),
                ], selection: $section)
                Divider()
                switch section {
                case .agents: AgentsListView()
                case .sessions: SessionsListView()
                case .local: LocalHubView()
                }
            }
            .navigationTitle("Live")
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
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
    }
}
