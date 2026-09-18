import SwiftUI

/// Top-level navigation. Mirrors the web sidebar groups:
/// Overview · Run (Tasks/Jobs/Reviews/Issues/Scheduled) · Live (Agents/Sessions/Local)
/// · Insights (Analytics/Costs/Activity/Cluster) · More (Library + Admin + Settings).
struct MainTabView: View {
    @State private var router = AppRouter()

    var body: some View {
        TabView(selection: $router.selectedTab) {
            OverviewView()
                .tabItem { Label("Overview", systemImage: "square.grid.2x2") }
                .tag(AppRouter.Tab.overview)
            RunHubView()
                .tabItem { Label("Run", systemImage: "play.circle") }
                .tag(AppRouter.Tab.run)
            LiveHubView()
                .tabItem { Label("Live", systemImage: "dot.radiowaves.left.and.right") }
                .tag(AppRouter.Tab.live)
            InsightsHubView()
                .tabItem { Label("Insights", systemImage: "chart.bar") }
                .tag(AppRouter.Tab.insights)
            MoreHubView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
                .tag(AppRouter.Tab.more)
        }
        .environment(router)
    }
}
