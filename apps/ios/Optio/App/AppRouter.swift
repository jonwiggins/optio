import Foundation
import Observation

/// Cross-tab navigation. Feature hubs read `selectedTab` / `pendingSection` so a tap on
/// an Overview tile can land on, say, Work › Sessions (in a given view) or Library ›
/// Machines. Hubs consume `pendingSection` (set it back to nil) once they've switched.
@MainActor
@Observable
final class AppRouter {
    enum Tab: Hashable { case overview, work, library, insights, more }

    enum Section: Hashable {
        case sessions, reviews, inbox
        case prompts, repos, machines, connections
        case analytics, costs, activity, cluster
    }

    var selectedTab: Tab = .overview
    var pendingSection: Section?
    /// The Sessions view to select once the Sessions screen is on screen (Overview
    /// tiles, `optio://section/sessions?view=…`). The screen consumes it.
    var pendingSessionView: SessionView?
    /// `optio://sessions/new` (the New session control / widget): the Sessions screen
    /// presents its New session sheet and sets this back to false.
    var pendingNewSession = false
    /// A detail to open once the owning hub is on screen: (kind, id, compose). Hubs
    /// consume it (set nil) after pushing the detail view.
    var pendingDetail: PendingDetail?
    /// A session the New session form just created: the Work hub pushes its detail
    /// and shows `createdToast`, then clears both.
    var createdSession: SessionDestination?
    var createdToast: String?

    struct PendingDetail: Hashable {
        enum Kind: Hashable { case task, local, agent, session }
        let kind: Kind
        let id: String
        var compose = false
    }

    /// Legacy `optio://section/<name>` names (and the pre-v0.5 nav) → where they live now.
    /// Every old per-kind list is a view of the one Sessions list.
    static func section(named name: String) -> (Section, SessionView?)? {
        switch name {
        case "sessions": return (.sessions, nil)
        case "tasks": return (.sessions, .all)
        case "jobs", "scheduled": return (.sessions, .recurring)
        case "agents": return (.sessions, .agents)
        case "local": return (.sessions, .active)
        case "reviews": return (.reviews, nil)
        case "issues", "inbox": return (.inbox, nil)
        case "prompts", "templates": return (.prompts, nil)
        case "repos": return (.repos, nil)
        case "machines", "hosts": return (.machines, nil)
        case "connections": return (.connections, nil)
        case "analytics": return (.analytics, nil)
        case "costs": return (.costs, nil)
        case "activity": return (.activity, nil)
        case "cluster": return (.cluster, nil)
        default: return nil
        }
    }

    /// Handles `optio://` URLs from widgets, Live Activity buttons, notifications and intents.
    @discardableResult
    func handle(url: URL) -> Bool {
        guard let link = DeepLink(url: url) else { return false }
        switch link {
        case .task(let id): pendingDetail = .init(kind: .task, id: id); open(.sessions)
        case .local(let id, let compose): pendingDetail = .init(kind: .local, id: id, compose: compose); open(.sessions)
        case .agent(let id, let compose): pendingDetail = .init(kind: .agent, id: id, compose: compose); open(.sessions)
        case .session(let id): pendingDetail = .init(kind: .session, id: id); open(.sessions)
        case .needsYou: pendingDetail = nil; open(.sessions, view: .active)
        case .newSession: pendingDetail = nil; pendingNewSession = true; open(.sessions)
        case .sessions(let view): pendingDetail = nil; open(.sessions, view: SessionView(rawValue: view) ?? .active)
        case .section(let name):
            if let (section, view) = Self.section(named: name) {
                let explicit = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                    .first { $0.name == "view" }?.value.flatMap(SessionView.init(rawValue:))
                open(section, view: explicit ?? view)
            } else if name == "more" {
                selectedTab = .more
            } else {
                return false
            }
        }
        return true
    }

    func open(_ section: Section, view: SessionView? = nil) {
        pendingSection = section
        if section == .sessions, let view { pendingSessionView = view }
        selectedTab = tab(for: section)
    }

    /// After the New session form submits: land on the session's detail screen.
    func showCreatedSession(_ destination: SessionDestination, toast: String) {
        createdSession = destination
        createdToast = toast
        open(.sessions)
    }

    /// Straight to the Sessions list in a given view (Overview tiles).
    func openSessions(_ view: SessionView) { open(.sessions, view: view) }

    func tab(for section: Section) -> Tab {
        switch section {
        case .sessions, .reviews, .inbox: return .work
        case .prompts, .repos, .machines, .connections: return .library
        case .analytics, .costs, .activity, .cluster: return .insights
        }
    }
}
