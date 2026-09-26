import Foundation

/// "Later" for a needs-you item. Server-side snooze is the source of truth
/// (`POST /api/local/terminals/:id/snooze`); when the server is unreachable or
/// predates the route we fall back to a local snooze window in the App Group
/// defaults so the widgets and the in-app queue still agree on this phone.
///
/// Key `optio.snoozed.<terminalId>` = expiry `Date`; the widget and Live Activity
/// intents write and read the same per-id keys.
enum SnoozeStore {
    static let defaultMinutes = 15

    static func key(_ id: String) -> String { "optio.snoozed.\(id)" }

    static func snoozedUntil(_ id: String) -> Date? {
        SharedCredentials.defaults.object(forKey: key(id)) as? Date
    }

    static func snoozeLocally(_ id: String, minutes: Int = defaultMinutes) {
        SharedCredentials.defaults.set(Date().addingTimeInterval(Double(minutes * 60)), forKey: key(id))
    }

    static func isSnoozed(_ id: String, now: Date = .now) -> Bool {
        (snoozedUntil(id) ?? .distantPast) > now
    }

    /// Server first, local fallback. Never throws: "Later" must always succeed from a banner.
    /// The Watch moves on at once, as it does for its own **Later** button.
    static func snooze(_ id: String, minutes: Int = defaultMinutes, api: APIClient?) async {
        let now = Date()
        let until = now.addingTimeInterval(Double(minutes * 60))
        await WatchActions.redrawWatch(handling: id, at: now) { $0.snoozedUntil = until }
        if let api, api.isConfigured {
            struct Body: Encodable { let minutes: Int }
            if (try? await api.post("/api/local/terminals/\(id)/snooze", body: Body(minutes: minutes))) != nil {
                return
            }
        }
        snoozeLocally(id, minutes: minutes)
    }
}
