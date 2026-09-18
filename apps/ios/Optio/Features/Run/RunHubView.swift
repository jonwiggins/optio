import SwiftUI

struct RunHubView: View {
    var body: some View {
        NavigationStack {
            EmptyState(title: "Run", systemImage: "hammer", message: "Coming soon")
                .navigationTitle("Run")
        }
    }
}
