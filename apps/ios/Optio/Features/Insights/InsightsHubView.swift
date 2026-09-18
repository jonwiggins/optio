import SwiftUI

struct InsightsHubView: View {
    var body: some View {
        NavigationStack {
            EmptyState(title: "Insights", systemImage: "hammer", message: "Coming soon")
                .navigationTitle("Insights")
        }
    }
}
