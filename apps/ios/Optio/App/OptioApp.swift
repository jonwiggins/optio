import SwiftUI

@main
struct OptioApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @State private var session = SessionStore()
    @AppStorage(AppAppearance.storageKey) private var appearance: AppAppearance = .system

    var body: some Scene {
        WindowGroup {
            RootView()
                .environment(session)
                .tint(AppTheme.accent)
                .preferredColorScheme(appearance.colorScheme)
                .task {
                    AppRefresh.register()
                    PushRegistrar.shared.attach(session: session)
                    await session.restore()
                }
        }
    }
}
