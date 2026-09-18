import AppIntents
import Foundation
import WidgetKit

/// Buttons on the Watch activity. These run inside the widget extension (no app
/// launch), talk to the API through `SharedFetch`, and degrade to App-Group state
/// when the server is unreachable or the endpoint is not deployed yet.
///
/// The island itself is only refreshed by the app (`LiveActivityManager`) or by an
/// APNs update: after **Later** the reorder shows up on the next reconcile / push.
enum WatchActions {
    /// "Later": server-side snooze (`POST /api/local/terminals/:id/snooze`) mirrored in
    /// the App Group (`optio.snoozed.<id>` = expiry) — the same fallback the Needs You
    /// widget reads — so phone surfaces agree even when the request fails.
    static func snooze(id: String, kind: String, minutes: Int = 15) async {
        let until = Date().addingTimeInterval(TimeInterval(minutes * 60))
        SharedCredentials.defaults.set(until, forKey: "optio.snoozed.\(id)")
        if kind == WatchItem.Kind.local.rawValue, let fetch = SharedFetch() {
            _ = try? await fetch.post("/api/local/terminals/\(id)/snooze", json: ["minutes": minutes])
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    static func taskAction(id: String, _ action: String) async {
        guard let fetch = SharedFetch() else { return }
        _ = try? await fetch.post("/api/tasks/\(id)/\(action)", json: [:])
        WidgetCenter.shared.reloadAllTimelines()
    }
}

struct LaterIntent: AppIntent {
    static let title: LocalizedStringResource = "Later"
    static let description = IntentDescription("Move this item to the back of the queue for 15 minutes.")
    static let isDiscoverable = false

    @Parameter(title: "Item") var itemId: String
    @Parameter(title: "Kind") var kind: String

    init() {}
    init(item: WatchItem) {
        itemId = item.id
        kind = item.kind.rawValue
    }

    func perform() async throws -> some IntentResult {
        await WatchActions.snooze(id: itemId, kind: kind)
        return .result()
    }
}

struct ResumeTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Resume task"
    static let description = IntentDescription("Resume a task that needs attention.")
    static let isDiscoverable = false

    @Parameter(title: "Task") var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        await WatchActions.taskAction(id: taskId, "resume")
        return .result()
    }
}

struct RetryTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Retry task"
    static let description = IntentDescription("Retry a failed task.")
    static let isDiscoverable = false

    @Parameter(title: "Task") var taskId: String

    init() {}
    init(taskId: String) { self.taskId = taskId }

    func perform() async throws -> some IntentResult {
        await WatchActions.taskAction(id: taskId, "retry")
        return .result()
    }
}
