import SwiftUI

/// Auth gate: shows sign-in until a server URL + token pair has been verified.
struct RootView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .restoring:
                ProgressView("Connecting…")
            case .signedOut:
                SignInView()
            case .signedIn:
                MainTabView()
                    .environment(session.api)
                    .environment(session.events)
            }
        }
        .animation(.default, value: session.phase)
    }
}
