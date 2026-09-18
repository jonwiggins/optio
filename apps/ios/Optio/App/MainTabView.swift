import SwiftUI

/// Top-level navigation. Mirrors the web sidebar groups:
/// Overview · Run (Tasks/Jobs/Reviews/Issues/Scheduled) · Live (Local/Agents/Sessions)
/// · Insights (Analytics/Costs/Activity/Cluster) · More (Library + Admin + Settings).
struct MainTabView: View {
    @State private var router = AppRouter()

    var body: some View {
        tabs
            .tint(AppTheme.accent)
            .environment(router)
            .modifier(LiveActivityHost())
            .onOpenURL { url in router.handle(url: url) }
            .onReceive(NotificationCenter.default.publisher(for: .optioOpenURL)) { note in if let url = note.object as? URL { router.handle(url: url) } }
            .onAppear(perform: applyDevSection)
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

    /// DEBUG: `SIMCTL_CHILD_OPTIO_DEV_SECTION=local xcrun simctl launch booted dev.optio.ios`
    /// opens the app on a given section so screens can be screenshotted from the CLI.
    private func applyDevSection() {
        #if DEBUG
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
