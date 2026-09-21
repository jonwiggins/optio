import SwiftUI

/// The detail screen a session row leads to — the per-kind detail screens are
/// the destinations; the Sessions list is the only list in front of them (the
/// per-kind lists were retired on web and here alike).
struct WorkDestinationView: View {
    let destination: WorkDestination

    var body: some View {
        switch destination {
        case .task(let id): TaskDetailView(taskId: id)
        case .blueprint(let id): ScheduledDetailView(configId: id)
        case .job(let id): JobDetailView(jobId: id)
        case .jobRun(let jobId, let runId): JobRunDetailView(jobId: jobId, runId: runId)
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
    /// Registers the destinations for session rows on a `NavigationStack`. Every
    /// stack that shows `WorkRowView`s needs it.
    func workDestinations() -> some View {
        navigationDestination(for: WorkDestination.self) { WorkDestinationView(destination: $0) }
    }
}
