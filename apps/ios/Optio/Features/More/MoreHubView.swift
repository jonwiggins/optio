import SwiftUI

struct MoreHubView: View {
    var body: some View {
        NavigationStack {
            EmptyState(title: "More", systemImage: "hammer", message: "Coming soon")
                .navigationTitle("More")
        }
    }
}
