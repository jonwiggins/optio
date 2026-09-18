import SwiftUI

/// Top-level navigation. Mirrors the web sidebar groups:
/// Overview · Run (Tasks/Jobs/Reviews/Issues/Scheduled) · Live (Agents/Sessions/Local)
/// · Insights (Analytics/Costs/Activity/Cluster) · More (Library + Admin + Settings).
struct MainTabView: View {
    var body: some View {
        TabView {
            OverviewView()
                .tabItem { Label("Overview", systemImage: "square.grid.2x2") }
            RunHubView()
                .tabItem { Label("Run", systemImage: "play.circle") }
            LiveHubView()
                .tabItem { Label("Live", systemImage: "dot.radiowaves.left.and.right") }
            InsightsHubView()
                .tabItem { Label("Insights", systemImage: "chart.bar") }
            MoreHubView()
                .tabItem { Label("More", systemImage: "ellipsis.circle") }
        }
    }
}
