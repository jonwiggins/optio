import SwiftUI

/// The detail screen a session row leads to — the existing per-kind screens
/// are the destinations; only the list in front of them is unified.
struct SessionDestinationView: View {
    let destination: SessionDestination

    var body: some View {
        switch destination {
        case .task(let id): TaskDetailView(taskId: id)
        case .blueprint(let id): ScheduledDetailView(configId: id)
        case .job(let id): JobDetailView(jobId: id)
        case .localTerminal(let id): LocalTerminalScreen(terminalId: id)
        case .localBlueprint(let id): LocalBlueprintDestination(blueprintId: id)
        case .podSession(let id): SessionDetailView(sessionId: id)
        case .agent(let id): AgentDetailView(agentId: id)
        }
    }
}

/// `LocalBlueprintDetailView` wants the host list for its edit form; fetch it on the way in.
private struct LocalBlueprintDestination: View {
    let blueprintId: String
    @Environment(APIClient.self) private var api
    @State private var hosts: [LocalHost]?

    var body: some View {
        Group {
            if let hosts {
                LocalBlueprintDetailView(blueprintId: blueprintId, hosts: hosts)
            } else {
                ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .task { hosts = (try? await api.listLocalHosts()) ?? [] }
    }
}

extension View {
    /// Registers the destinations for session rows and the "browse by kind" routes
    /// on a `NavigationStack`. Every stack that shows `SessionRowView`s needs it.
    func sessionDestinations() -> some View {
        navigationDestination(for: SessionDestination.self) { SessionDestinationView(destination: $0) }
            .navigationDestination(for: SessionBrowseRoute.self) { route in
                Group {
                    switch route {
                    case .tasks: TasksListView()
                    case .jobs: JobsListView()
                    case .scheduled: ScheduledListView()
                    case .agents: AgentsListView()
                    case .podSessions: SessionsListView()
                    case .local: LocalHubView()
                    }
                }
                .navigationTitle(route.label)
                .navigationBarTitleDisplayMode(.inline)
            }
    }
}

/// The per-kind management lists, reachable from the Sessions screen's "Browse by
/// kind" menu rather than the tab bar (the web keeps `/tasks`, `/jobs`, `/agents`,
/// `/local`, `/tasks/scheduled` as pages outside the nav the same way).
enum SessionBrowseRoute: Hashable, CaseIterable {
    case tasks, jobs, scheduled, agents, podSessions, local

    var label: String {
        switch self {
        case .tasks: return "Tasks"
        case .jobs: return "Jobs"
        case .scheduled: return "Scheduled"
        case .agents: return "Agents"
        case .podSessions: return "Pod sessions"
        case .local: return "Local terminals"
        }
    }

    var systemImage: String {
        switch self {
        case .tasks: return "checklist"
        case .jobs: return "bolt"
        case .scheduled: return "calendar"
        case .agents: return "cpu"
        case .podSessions: return "server.rack"
        case .local: return "laptopcomputer"
        }
    }
}
