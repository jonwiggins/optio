import SwiftUI

/// Insights tab: Analytics · Costs · Activity · Cluster, switched with a chip row.
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
                ChipPicker(options: Section.allCases.map { ($0, $0.label) }, selection: $section)
                Divider()
                Group {
                    switch section {
                    case .analytics: AnalyticsView()
                    case .costs: CostsView()
                    case .activity: ActivityView()
                    case .cluster: ClusterView()
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
            .navigationTitle("Insights")
            .navigationBarTitleDisplayMode(.inline)
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
