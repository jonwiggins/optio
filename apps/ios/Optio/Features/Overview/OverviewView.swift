import SwiftUI

struct OverviewView: View {
    var body: some View {
        NavigationStack {
            EmptyState(title: "Overview", systemImage: "hammer", message: "Coming soon")
                .navigationTitle("Overview")
        }
    }
}
