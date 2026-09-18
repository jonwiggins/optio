import Foundation

/// Pure decisions behind the widget timeline: refresh cadence, staleness, snooze
/// ordering and the "started" flash. Deliberately Foundation-only (no WidgetKit, no
/// Shared types) so `scripts/test-glance-policy.sh` can compile and run it with bare
/// `swiftc` — the extension target is not linked into `OptioTests`.
enum GlancePolicy {
    /// How the last load went; drives cadence and the widget's honesty footer.
    enum Reachability: Equatable {
        case signedOut
        case unreachable
        case live
    }

    /// Timeline refresh interval, in seconds.
    ///
    /// - 5 min while anything is running or waiting on you (the number people watch),
    /// - 15 min when quiet,
    /// - 60 min when signed out or the laptop is unreachable (nothing to gain by polling).
    /// Stays inside WidgetKit's ~40–70 reloads/day budget in every state.
    static func refreshInterval(_ reachability: Reachability, anyRunning: Bool, anyNeedsYou: Bool) -> TimeInterval {
        switch reachability {
        case .signedOut, .unreachable: return 60 * 60
        case .live: return (anyRunning || anyNeedsYou) ? 5 * 60 : 15 * 60
        }
    }

    /// Past this age the widget shows its `asOf` time in the footer instead of pretending to be live.
    static let staleAfter: TimeInterval = 20 * 60

    static func isStale(asOf: Date, now: Date) -> Bool {
        now.timeIntervalSince(asOf) > staleAfter
    }

    /// Snoozed ("Later") items keep their place in the data but move to the back of the
    /// queue for the snooze window. Order within each group is preserved.
    static func applySnooze<Item>(_ items: [Item], id: (Item) -> String, snoozedUntil: [String: Date], now: Date) -> [Item] {
        func snoozed(_ item: Item) -> Bool {
            if let until = snoozedUntil[id(item)] { return until > now }
            return false
        }
        return items.filter { !snoozed($0) } + items.filter { snoozed($0) }
    }

    /// The Run widget/control shows "Started · Xs ago" for one timeline entry after firing.
    static let startedFlash: TimeInterval = 60

    static func showsStarted(lastStartedAt: Date?, now: Date) -> Bool {
        guard let lastStartedAt else { return false }
        let age = now.timeIntervalSince(lastStartedAt)
        return age >= 0 && age < startedFlash
    }

    /// A two-tap confirmation for the Run widget: the first tap arms it for this long.
    static let armWindow: TimeInterval = 10

    static func isArmed(armedAt: Date?, now: Date) -> Bool {
        guard let armedAt else { return false }
        let age = now.timeIntervalSince(armedAt)
        return age >= 0 && age < armWindow
    }

    /// Compact wait time for rows and accessories: "4m", "2h", "3d"; never seconds
    /// (the lock screen is not a stopwatch).
    static func waitText(since: Date, now: Date) -> String {
        let s = max(0, now.timeIntervalSince(since))
        if s < 60 { return "now" }
        if s < 3600 { return "\(Int(s / 60))m" }
        if s < 86400 { return "\(Int(s / 3600))h" }
        return "\(Int(s / 86400))d"
    }
}
