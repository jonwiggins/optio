import OSLog
import SwiftUI

/// Top-level navigation. Mirrors the web sidebar groups:
/// Overview · Run (Tasks/Jobs/Reviews/Issues/Scheduled) · Live (Local/Agents/Sessions)
/// · Insights (Analytics/Costs/Activity/Cluster) · More (Library + Admin + Settings).
struct MainTabView: View {
    @Environment(SessionStore.self) private var session
    @State private var router = AppRouter()
    private static let log = Logger(subsystem: "dev.optio.ios", category: "router")

    var body: some View {
        tabs
            .tint(AppTheme.accent)
            .environment(router)
            .onOpenURL { url in handle(url: url) }
            .onReceive(NotificationCenter.default.publisher(for: .optioOpenURL)) { note in if let url = note.object as? URL { handle(url: url) } }
            .onAppear {
                applyDevSection()
                // A link that arrived mid-switch (or before sign-in) is re-posted now that
                // the shell for the right server is on screen.
                NotificationHandler.shared.flushPendingURL()
            }
    }

    /// `optio://…?server=<id>` targets a specific paired server: switch first, then let
    /// the rebuilt shell route the link. Links without a hint route on the active server.
    private func handle(url: URL) {
        Self.log.notice("deep link \(url.absoluteString, privacy: .public) active=\(session.activeServer?.id ?? "-", privacy: .public) servers=\(session.servers.map(\.id).joined(separator: ","), privacy: .public)")
        if let target = DeepLink.serverId(in: url), target != session.activeServer?.id,
           session.servers.contains(where: { $0.id == target }) {
            NotificationHandler.shared.stash(url: url)
            Task { await session.switchTo(target) }
            return
        }
        router.handle(url: url)
    }

    @ViewBuilder
    private var tabs: some View {
        if #available(iOS 26, *) {
            TabView(selection: $router.selectedTab) {
                Tab("Overview", systemImage: "square.grid.2x2", value: AppRouter.Tab.overview) { OverviewView() }
                Tab("Run", systemImage: "play", value: AppRouter.Tab.run) { RunHubView() }
                Tab("Live", systemImage: "dot.radiowaves.left.and.right", value: AppRouter.Tab.live) { LiveHubView() }
                Tab("Insights", systemImage: "chart.bar", value: AppRouter.Tab.insights) { InsightsHubView() }
                Tab("More", systemImage: "ellipsis", value: AppRouter.Tab.more) { MoreHubView() }
            }
            .tabBarMinimizeBehavior(.onScrollDown)
        } else if #available(iOS 18, *) {
            TabView(selection: $router.selectedTab) {
                Tab("Overview", systemImage: "square.grid.2x2", value: AppRouter.Tab.overview) { OverviewView() }
                Tab("Run", systemImage: "play", value: AppRouter.Tab.run) { RunHubView() }
                Tab("Live", systemImage: "dot.radiowaves.left.and.right", value: AppRouter.Tab.live) { LiveHubView() }
                Tab("Insights", systemImage: "chart.bar", value: AppRouter.Tab.insights) { InsightsHubView() }
                Tab("More", systemImage: "ellipsis", value: AppRouter.Tab.more) { MoreHubView() }
            }
        } else {
            TabView(selection: $router.selectedTab) {
                OverviewView().tabItem { Label("Overview", systemImage: "square.grid.2x2") }.tag(AppRouter.Tab.overview)
                RunHubView().tabItem { Label("Run", systemImage: "play") }.tag(AppRouter.Tab.run)
                LiveHubView().tabItem { Label("Live", systemImage: "dot.radiowaves.left.and.right") }.tag(AppRouter.Tab.live)
                InsightsHubView().tabItem { Label("Insights", systemImage: "chart.bar") }.tag(AppRouter.Tab.insights)
                MoreHubView().tabItem { Label("More", systemImage: "ellipsis") }.tag(AppRouter.Tab.more)
            }
        }
    }

    #if DEBUG
    @MainActor private static var devURLDelivered = false
    #endif

    /// DEBUG: `SIMCTL_CHILD_OPTIO_DEV_SECTION=local xcrun simctl launch booted dev.optio.ios`
    /// opens the app on a given section so screens can be screenshotted from the CLI.
    private func applyDevSection() {
        #if DEBUG
        // `OPTIO_DEV_OPEN_URL=optio://section/tasks?server=dev-server_2` delivers a deep link
        // ~2 s after launch, without the system "Open in Optio?" prompt `simctl openurl` shows.
        if let raw = ProcessInfo.processInfo.environment["OPTIO_DEV_OPEN_URL"], let url = URL(string: raw), !Self.devURLDelivered {
            Self.devURLDelivered = true
            Task { @MainActor in
                try? await Task.sleep(for: .seconds(2))
                NotificationHandler.shared.deliver(url: url)
            }
        }
        guard let raw = ProcessInfo.processInfo.environment["OPTIO_DEV_SECTION"] else { return }
        let sections: [String: AppRouter.Section] = [
            "tasks": .tasks, "jobs": .jobs, "reviews": .reviews, "issues": .issues, "scheduled": .scheduled,
            "agents": .agents, "sessions": .sessions, "local": .local,
            "analytics": .analytics, "costs": .costs, "activity": .activity, "cluster": .cluster,
        ]
        if let section = sections[raw] { router.open(section) } else if raw == "more" { router.selectedTab = .more }
        #endif
    }
}

/// Section switcher for a hub tab: one native segmented control pinned under
/// the tab's large title. The title is the tab's name; child lists never
/// restate the section name. (A bottom-bar placement renders behind the iOS 26
/// floating tab bar, so this stays in the content column.)
struct HubSwitcher<T: Hashable>: View {
    let options: [(T, String)]
    @Binding var selection: T

    var body: some View {
        Picker("Section", selection: $selection) {
            ForEach(options, id: \.0) { value, label in
                Text(label).tag(value)
            }
        }
        .pickerStyle(.segmented)
        .padding(.horizontal, Spacing.l)
        .padding(.bottom, Spacing.s)
        .sensoryFeedback(.selection, trigger: selection)
    }
}

extension View {
    /// Hub chrome: black-and-white toolbar controls (purple stays for needs-you and the selected tab).
    func hubChrome() -> some View {
        tint(.primary)
    }
}
