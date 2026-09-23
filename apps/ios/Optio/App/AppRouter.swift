import Foundation
import Observation

/// Cross-tab navigation. Feature hubs read `selectedTab` / `pendingSection` so a tap on
/// an Overview tile can land on, say, Work (in a given view) or Library ›
/// Machines. Hubs consume `pendingSection` (set it back to nil) once they've switched.
@MainActor
@Observable
final class AppRouter {
    enum Tab: Hashable { case overview, work, library, insights, more }

    enum Section: Hashable {
        case work, reviews, inbox
        case prompts, repos, machines, connections
        case analytics, costs, activity, cluster
    }

    var selectedTab: Tab = .overview
    var pendingSection: Section?
    /// The Work view to select once the Work list is on screen (Overview tiles,
    /// `optio://section/work?view=…`). The screen consumes it.
    var pendingWorkView: WorkView?
    /// `optio://work/new` (the New work control / widget): the Work list presents
    /// its New work sheet and sets this back to false.
    var pendingNewWork = false
    /// A detail to open once the owning hub is on screen: (kind, id, compose). Hubs
    /// consume it (set nil) after pushing the detail view.
    var pendingDetail: PendingDetail?
    /// What the New work form just created: the Work hub pushes its detail and
    /// shows `createdToast`, then clears both.
    var createdWork: WorkDestination?
    var createdToast: String?

    struct PendingDetail: Hashable {
        enum Kind: Hashable { case task, local, agent, session }
        let kind: Kind
        let id: String
        var compose = false
    }

    /// Legacy `optio://section/<name>` names (and the pre-v0.6 nav) → where they live now.
    /// Every old per-kind list is a view of the one Work list.
    static func section(named name: String) -> (Section, WorkView?)? {
        switch name {
        case "work", "sessions": return (.work, nil)
        case "tasks": return (.work, .all)
        case "jobs", "scheduled": return (.work, .recurring)
        case "agents": return (.work, .agents)
        case "local": return (.work, .active)
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
        case .task(let id): pendingDetail = .init(kind: .task, id: id); open(.work)
        case .local(let id, let compose): pendingDetail = .init(kind: .local, id: id, compose: compose); open(.work)
        case .agent(let id, let compose): pendingDetail = .init(kind: .agent, id: id, compose: compose); open(.work)
        case .session(let id): pendingDetail = .init(kind: .session, id: id); open(.work)
        case .needsYou: pendingDetail = nil; open(.work, view: .active)
        case .newWork: pendingDetail = nil; pendingNewWork = true; open(.work)
        case .work(let view): pendingDetail = nil; open(.work, view: WorkView(rawValue: view) ?? .active)
        case .section(let name):
            if let (section, view) = Self.section(named: name) {
                let explicit = URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems?
                    .first { $0.name == "view" }?.value.flatMap(WorkView.init(rawValue:))
                open(section, view: explicit ?? view)
            } else if name == "more" {
                selectedTab = .more
            } else {
                return false
            }
        case .settings: pendingDetail = nil; selectedTab = .more
        }
        return true
    }

    func open(_ section: Section, view: WorkView? = nil) {
        pendingSection = section
        if section == .work, let view { pendingWorkView = view }
        selectedTab = tab(for: section)
    }

    /// After the New work form submits: land on its detail screen.
    func showCreatedWork(_ destination: WorkDestination, toast: String) {
        createdWork = destination
        createdToast = toast
        open(.work)
    }

    /// Straight to the Work list in a given view (Overview tiles).
    func openWork(_ view: WorkView) { open(.work, view: view) }

    func tab(for section: Section) -> Tab {
        switch section {
        case .work, .reviews, .inbox: return .work
        case .prompts, .repos, .machines, .connections: return .library
        case .analytics, .costs, .activity, .cluster: return .insights
        }
    }
}
