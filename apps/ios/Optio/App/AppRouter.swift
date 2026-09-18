import Foundation
import Observation

/// Cross-tab navigation. Feature hubs read `selectedTab` / `pendingSection` so a tap on
/// an Overview tile can land on, say, Run › Tasks or Live › Local. Hubs consume
/// `pendingSection` (set it back to nil) once they've switched.
@MainActor
@Observable
final class AppRouter {
    enum Tab: Hashable { case overview, run, live, insights, more }

    enum Section: Hashable {
        case tasks, jobs, reviews, issues, scheduled
        case agents, sessions, local
        case analytics, costs, activity, cluster
    }

    var selectedTab: Tab = .overview
    var pendingSection: Section?
    /// A detail to open once the owning hub is on screen: (kind, id, compose). Hubs
    /// consume it (set nil) after pushing the detail view.
    var pendingDetail: PendingDetail?

    struct PendingDetail: Hashable {
        enum Kind: Hashable { case task, local, agent, session }
        let kind: Kind
        let id: String
        var compose = false
    }

    /// Handles `optio://` URLs from widgets, Live Activity buttons, notifications and intents.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let link = DeepLink(url: url) else { return false }
        switch link {
        case .task(let id): pendingDetail = .init(kind: .task, id: id); open(.tasks)
        case .local(let id, let compose): pendingDetail = .init(kind: .local, id: id, compose: compose); open(.local)
        case .agent(let id, let compose): pendingDetail = .init(kind: .agent, id: id, compose: compose); open(.agents)
        case .session(let id): pendingDetail = .init(kind: .session, id: id); open(.sessions)
        case .needsYou: pendingDetail = nil; open(.local)
        case .section(let name):
            let map: [String: Section] = ["tasks": .tasks, "jobs": .jobs, "reviews": .reviews, "issues": .issues, "scheduled": .scheduled, "agents": .agents, "sessions": .sessions, "local": .local, "analytics": .analytics, "costs": .costs, "activity": .activity, "cluster": .cluster]
            if let s = map[name] { open(s) } else if name == "more" { selectedTab = .more } else { return false }
        }
        return true
    }

    func open(_ section: Section) {
        pendingSection = section
        switch section {
        case .tasks, .jobs, .reviews, .issues, .scheduled: selectedTab = .run
        case .agents, .sessions, .local: selectedTab = .live
        case .analytics, .costs, .activity, .cluster: selectedTab = .insights
        }
    }
}
