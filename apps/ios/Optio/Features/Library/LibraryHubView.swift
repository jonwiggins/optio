import SwiftUI

/// The "Library" tab: Prompts · Repos · Machines · Connections, matching the web
/// sidebar group. The three admin lists came from the old More tab and still
/// read `MoreContext` for role gating, so the hub owns one.
struct LibraryHubView: View {
    enum Section: String, CaseIterable { case prompts, repos, machines, connections }
    @Environment(APIClient.self) private var api
    @Environment(SessionStore.self) private var session
    @Environment(AppRouter.self) private var router
    @State private var section: Section = .prompts
    @State private var context = MoreContext()

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HubSwitcher(options: [(Section.prompts, "Prompts"), (.repos, "Repos"), (.machines, "Machines"), (.connections, "Connections")], selection: $section)
                Group {
                    switch section {
                    case .prompts: PromptsListView()
                    case .repos: ReposListView()
                    case .machines: MachinesView()
                    case .connections: ConnectionsView()
                    }
                }
                .id(section)
            }
            .navigationTitle("Library")
            .hubChrome()
            .serverSwitcherToolbar()
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
        }
        // On the stack, not the List: pushed destinations inherit the stack's environment.
        .environment(context)
        .task { await context.refresh(api: api, session: session) }
    }

    /// Cross-tab deep link from `AppRouter.open(_:)`.
    private func consumeRoute() {
        guard let pending = router.pendingSection else { return }
        let mapped: Section? = switch pending {
        case .prompts: .prompts
        case .repos: .repos
        case .machines: .machines
        case .connections: .connections
        default: nil
        }
        guard let mapped else { return }
        section = mapped
        router.pendingSection = nil
    }
}
