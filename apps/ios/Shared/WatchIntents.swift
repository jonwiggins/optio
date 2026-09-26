import ActivityKit
import AppIntents
import Foundation
import WidgetKit

/// Buttons on the Watch activity, plus the Sessions widget's **Later** moon. They are
/// `LiveActivityIntent`s, so the system runs them in the app's process, launching it
/// in the background when it isn't running. That is the process allowed to update the
/// Live Activity, so a tap redraws the island at once instead of waiting for the app's
/// next reconcile or an APNs push (which not every server has). The file lives in
/// `Shared/` because both targets must compile these types: the widget extension
/// renders the buttons and the app performs them.
///
/// Every intent carries the item's `serverId` so a button on a second laptop's item
/// talks to that laptop; a missing id (older payloads) means the active server.
enum WatchActions {
    static let snoozeMinutes = 15

    /// "Later". The App Group snooze (`optio.snoozed.<id>` = expiry) comes first: the
    /// widgets and the app's reconcile read it, so phone surfaces agree even when the
    /// request fails. Then the island, then the server
    /// (`POST /api/local/terminals/:id/snooze`).
    static func snooze(id: String, kind: String, serverId: String?, minutes: Int = snoozeMinutes) async {
        let now = Date()
        let until = now.addingTimeInterval(TimeInterval(minutes * 60))
        SharedCredentials.defaults.set(until, forKey: "optio.snoozed.\(id)")
        await redrawWatch(handling: id, at: now) { $0.snoozedUntil = until }
        if kind == WatchItem.Kind.local.rawValue, let fetch = SharedFetch.resolve(serverId) {
            _ = try? await fetch.post("/api/local/terminals/\(id)/snooze", json: ["minutes": minutes])
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Resume or Retry a task. The island moves on only once the server accepted the
    /// action, so a refused one leaves the task where the user can see it.
    static func taskAction(id: String, serverId: String?, _ action: String) async {
        guard let fetch = SharedFetch.resolve(serverId) else { return }
        if (try? await fetch.post("/api/tasks/\(id)/\(action)", json: [:])) != nil {
            // Both endpoints put the task back in the queue (`queued`), which is what
            // the next reconcile will read from the server.
            await redrawWatch(handling: id) { item in
                item.state = "queued"
                item.statusLabel = NeedsYouSnapshot.taskStatusLabel("queued")
                item.reason = "Queued"
            }
        }
        WidgetCenter.shared.reloadAllTimelines()
    }

    /// Redraw each live Watch with `id` handled (`WatchState.handling`). Does nothing
    /// when no Watch is asking about `id`, or outside the app's process.
    static func redrawWatch(handling id: String, at now: Date = .now, update: (inout WatchItem) -> Void = { _ in }) async {
        for activity in Activity<WatchAttributes>.activities {
            guard let next = activity.content.state.handling(id, at: now, update: update) else { continue }
            await activity.update(next.activityContent(at: now))
        }
    }
}

struct LaterIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Later"
    static let description = IntentDescription("Take this session out of the queue for 15 minutes.")
    static let isDiscoverable = false

    @Parameter(title: "Item") var itemId: String
    @Parameter(title: "Kind") var kind: String
    @Parameter(title: "Server") var serverId: String?

    init() {}
    init(item: WatchItem) {
        itemId = item.id
        kind = item.kind.rawValue
        serverId = item.serverId
    }

    func perform() async throws -> some IntentResult {
        await WatchActions.snooze(id: itemId, kind: kind, serverId: serverId)
        return .result()
    }
}

struct ResumeTaskIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Resume task"
    static let description = IntentDescription("Resume a task that needs attention.")
    static let isDiscoverable = false

    @Parameter(title: "Task") var taskId: String
    @Parameter(title: "Server") var serverId: String?

    init() {}
    init(taskId: String, serverId: String? = nil) {
        self.taskId = taskId
        self.serverId = serverId
    }

    func perform() async throws -> some IntentResult {
        await WatchActions.taskAction(id: taskId, serverId: serverId, "resume")
        return .result()
    }
}

/// Not `RetryTaskIntent`: the app's Shortcuts intent of that name (Intents.swift) takes
/// a task entity, and this file compiles into the app too.
struct WatchRetryTaskIntent: LiveActivityIntent {
    static let title: LocalizedStringResource = "Retry task"
    static let description = IntentDescription("Retry a failed task.")
    static let isDiscoverable = false

    @Parameter(title: "Task") var taskId: String
    @Parameter(title: "Server") var serverId: String?

    init() {}
    init(taskId: String, serverId: String? = nil) {
        self.taskId = taskId
        self.serverId = serverId
    }

    func perform() async throws -> some IntentResult {
        await WatchActions.taskAction(id: taskId, serverId: serverId, "retry")
        return .result()
    }
}
