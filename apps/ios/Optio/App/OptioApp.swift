import SwiftUI

@main
struct OptioApp: App {
    @State private var session = SessionStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .tint(AppTheme.accent)
                .task { await session.restore() }
        }
    }
}
