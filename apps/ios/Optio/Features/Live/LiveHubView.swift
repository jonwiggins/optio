import SwiftUI

struct LiveHubView: View {
    var body: some View {
        NavigationStack {
            EmptyState(title: "Live", systemImage: "hammer", message: "Coming soon")
                .navigationTitle("Live")
        }
    }
}
