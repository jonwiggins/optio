import SwiftUI

/// Insights tab: Analytics · Costs · Activity · Cluster, switched from the toolbar.
struct InsightsHubView: View {
    enum Section: String, CaseIterable, Hashable {
        case analytics, costs, activity, cluster
        var label: String { rawValue.capitalized }
    }

    @State private var section: Section = .analytics
    @Environment(AppRouter.self) private var router

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HubSwitcher(options: Section.allCases.map { ($0, $0.label) }, selection: $section)
                Group {
                    switch section {
                    case .analytics: AnalyticsView()
                    case .costs: CostsView()
                    case .activity: ActivityView()
                    case .cluster: ClusterView()
                    }
                }
                .id(section)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle("Insights")
            .hubChrome()
            .onAppear(perform: consumeRoute)
            .onChange(of: router.pendingSection) { _, _ in consumeRoute() }
        }
    }

    /// Cross-tab deep link from `AppRouter.open(_:)`.
    private func consumeRoute() {
        guard let pending = router.pendingSection else { return }
        let mapped: Section? = switch pending {
        case .analytics: .analytics
        case .costs: .costs
        case .activity: .activity
        case .cluster: .cluster
        default: nil
        }
        guard let mapped else { return }
        section = mapped
        router.pendingSection = nil
    }
}
