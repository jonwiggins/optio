import SwiftUI

/// Creates the one `LiveActivityManager` per signed-in session from the environment
/// (`APIClient` / `EventHub` / `SessionStore`), starts it, publishes it back into the
/// environment (optional — screens read `@Environment(LiveActivityManager.self)` only
/// when they need the status row), reconciles on foreground, and stops it when the
/// signed-in shell disappears (sign-out). Attach once: `MainTabView { … }.modifier(LiveActivityHost())`.
struct LiveActivityHost: ViewModifier {
    @Environment(APIClient.self) private var api
    @Environment(EventHub.self) private var events
    @Environment(SessionStore.self) private var session
    @Environment(\.scenePhase) private var scenePhase
    @State private var manager: LiveActivityManager?

    func body(content: Content) -> some View {
        content
            .environment(manager)
            .task {
                guard manager == nil else { return }
                let m = LiveActivityManager(api: api, events: events, session: session)
                m.foreground = scenePhase == .active
                manager = m
                m.start()
            }
            .onChange(of: scenePhase) { _, phase in
                manager?.foreground = phase == .active
                switch phase {
                case .active: manager?.reconcileSoon()
                case .background: AppRefresh.schedule()
                default: break
                }
            }
            .onDisappear { manager?.stop(); manager = nil }
    }
}
