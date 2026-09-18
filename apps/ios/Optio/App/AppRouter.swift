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

    func open(_ section: Section) {
        pendingSection = section
        switch section {
        case .tasks, .jobs, .reviews, .issues, .scheduled: selectedTab = .run
        case .agents, .sessions, .local: selectedTab = .live
        case .analytics, .costs, .activity, .cluster: selectedTab = .insights
        }
    }
}
