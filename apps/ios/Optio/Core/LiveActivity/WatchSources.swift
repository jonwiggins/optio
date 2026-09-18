import Foundation

/// Repo Tasks the user follows on the Lock Screen ("Follow on Lock Screen" in task
/// detail). A followed task joins the Watch as an item; it never gets its own activity.
/// Stored as a plain id set in `UserDefaults` (`optio.followedTasks`); the manager
/// unfollows automatically when a task reaches `completed` / `cancelled` / final `failed`.
enum FollowedTasks {
    static let key = "optio.followedTasks"
    static let changed = Notification.Name("optio.followedTasks.changed")

    static var all: Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: key) ?? [])
    }

    static func contains(_ id: String) -> Bool { all.contains(id) }

    static func set(_ ids: Set<String>) {
        UserDefaults.standard.set(Array(ids).sorted(), forKey: key)
        NotificationCenter.default.post(name: changed, object: nil)
    }

    @discardableResult
    static func toggle(_ id: String) -> Bool {
        var ids = all
        let nowFollowing: Bool
        if ids.contains(id) { ids.remove(id); nowFollowing = false } else { ids.insert(id); nowFollowing = true }
        set(ids)
        return nowFollowing
    }

    static func remove(_ id: String) {
        var ids = all
        guard ids.remove(id) != nil else { return }
        set(ids)
    }
}

/// Persistent-agent messages sent from this phone, by agent id. A turn joins the Watch
/// (`working`, "Vesper is thinking") only if the user messaged that agent from here in
/// the last hour — scheduled/webhook turns never touch the island (brief §2c).
enum RecentAgentSends {
    static let key = "optio.recentAgentSends"
    static let changed = Notification.Name("optio.recentAgentSends.changed")
    static let window: TimeInterval = 60 * 60

    private static var table: [String: Date] {
        get { (UserDefaults.standard.dictionary(forKey: key) as? [String: Date]) ?? [:] }
        set { UserDefaults.standard.set(newValue, forKey: key) }
    }

    static func record(_ agentId: String, at date: Date = .now) {
        var t = table.filter { date.timeIntervalSince($0.value) < window }
        t[agentId] = date
        table = t
        NotificationCenter.default.post(name: changed, object: nil)
    }

    static func recent(at now: Date = .now) -> [String: Date] {
        table.filter { now.timeIntervalSince($0.value) < window }
    }

    static func isRecent(_ agentId: String, at now: Date = .now) -> Bool {
        recent(at: now)[agentId] != nil
    }
}

/// App-Group "Later" fallback written by the widget/activity intents (`optio.snoozed.<id>`).
enum LocalSnoozes {
    static func until(_ id: String) -> Date? {
        SharedCredentials.defaults.object(forKey: "optio.snoozed.\(id)") as? Date
    }
}
