import UIKit
import UserNotifications
import WidgetKit

/// Installed by `OptioApp` via `@UIApplicationDelegateAdaptor` for the callbacks
/// SwiftUI has no equivalent for: APNs token registration and the notification
/// center delegate (which must be set before the app finishes launching so a tap
/// on a notification that cold-starts the app is delivered).
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        UNUserNotificationCenter.current().delegate = NotificationHandler.shared
        NotificationCategory.register()
        return true
    }

    func application(_ application: UIApplication, didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        PushRegistrar.shared.didRegister(deviceToken: deviceToken)
    }

    func application(_ application: UIApplication, didFailToRegisterForRemoteNotificationsWithError error: Error) {
        PushRegistrar.shared.didFailToRegister(error: error)
    }

    /// Silent (`content-available`) pushes: refresh the glanceable surfaces.
    func application(_ application: UIApplication, didReceiveRemoteNotification userInfo: [AnyHashable: Any]) async -> UIBackgroundFetchResult {
        WidgetCenter.shared.reloadAllTimelines()
        for handler in AppRefresh.handlers { await handler() }
        return .newData
    }
}
