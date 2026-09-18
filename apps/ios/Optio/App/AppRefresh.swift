import BackgroundTasks
import Foundation
import WidgetKit

/// Background refresh (`BGAppRefreshTask`, id `dev.optio.ios.refresh`). iOS grants
/// these windows at its discretion (typically every 15+ minutes when the app is used
/// regularly); we use them to reload widget timelines and let registered handlers
/// (e.g. the Live Activity manager) reconcile against the API.
enum AppRefresh {
    static let identifier = "dev.optio.ios.refresh"
    /// Work to run inside a refresh window. Handlers must be quick (< 20 s total).
    nonisolated(unsafe) static var handlers: [() async -> Void] = []

    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: identifier, using: nil) { task in
            guard let task = task as? BGAppRefreshTask else { return }
            schedule()
            let work = Task {
                for h in handlers { await h() }
                WidgetCenter.shared.reloadAllTimelines()
                task.setTaskCompleted(success: true)
            }
            task.expirationHandler = { work.cancel(); task.setTaskCompleted(success: false) }
        }
        schedule()
    }

    static func schedule() {
        let request = BGAppRefreshTaskRequest(identifier: identifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        try? BGTaskScheduler.shared.submit(request)
    }
}
