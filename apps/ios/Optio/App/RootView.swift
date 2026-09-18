import SwiftUI

/// Auth gate: shows sign-in until at least one server URL + token pair has been
/// verified. The signed-in shell is keyed on `session.generation`, so switching
/// servers rebuilds every screen with fresh state for the new instance; the Live
/// Activity host sits outside that key and follows the switch instead of restarting.
struct RootView: View {
    @Environment(SessionStore.self) private var session

    var body: some View {
        Group {
            switch session.phase {
            case .restoring:
                ProgressView("Connecting…")
            case .signedOut:
                SignInView(mode: .first)
            case .signedIn:
                MainTabView()
                    .id(session.generation)
                    .modifier(LiveActivityHost())
                    .environment(session.api)
                    .environment(session.events)
            }
        }
        .animation(.default, value: session.phase)
    }
}
