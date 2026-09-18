import Foundation
import UserNotifications

/// Category and action identifiers registered with `UNUserNotificationCenter`.
/// These are the wire contract with the API's APNs alert payloads
/// (`aps.category` + the actions the app can perform from the banner); the
/// backend builds to exactly these strings. Change them in both places or not at all.
enum NotificationCategory: String, CaseIterable {
    /// A local terminal needs you (`stop` / `notification` / `quiet`).
    case localNeedsYou = "LOCAL_NEEDS_YOU"
    /// An automation-spawned terminal exited.
    case localExit = "LOCAL_EXIT"
    /// A local host went offline.
    case hostOffline = "HOST_OFFLINE"
    /// A Repo Task entered `needs_attention` or `failed`.
    case taskAttention = "TASK_ATTENTION"
    /// A Repo Task opened its PR.
    case taskPrOpened = "TASK_PR_OPENED"
    /// A Persistent Agent replied to a message you sent.
    case agentReply = "AGENT_REPLY"
    /// A Persistent Agent hit its failure limit.
    case agentFailed = "AGENT_FAILED"

    var actions: [NotificationAction] {
        switch self {
        case .localNeedsYou: return [.reply, .later]
        case .localExit: return [.open]
        case .hostOffline: return []
        case .taskAttention: return [.resume, .retry, .open]
        case .taskPrOpened: return [.openPR]
        case .agentReply: return [.reply]
        case .agentFailed: return [.resume]
        }
    }

    /// Categories whose alerts still show a banner while the app is in the foreground
    /// (unless the user is already looking at that object).
    var presentsInForeground: Bool {
        switch self {
        case .localNeedsYou, .taskAttention, .agentReply, .agentFailed: return true
        case .localExit, .hostOffline, .taskPrOpened: return false
        }
    }
}

enum NotificationAction: String {
    case reply = "REPLY"
    case later = "LATER"
    case open = "OPEN"
    case resume = "RESUME"
    case retry = "RETRY"
    case openPR = "OPEN_PR"

    var title: String {
        switch self {
        case .reply: return "Reply…"
        case .later: return "Later"
        case .open: return "Open"
        case .resume: return "Resume"
        case .retry: return "Retry"
        case .openPR: return "Open PR"
        }
    }

    var unAction: UNNotificationAction {
        switch self {
        case .reply:
            return UNTextInputNotificationAction(
                identifier: rawValue, title: title, options: [.authenticationRequired],
                textInputButtonTitle: "Send", textInputPlaceholder: "Your reply")
        case .later:
            return UNNotificationAction(identifier: rawValue, title: title, options: [])
        case .open, .openPR:
            return UNNotificationAction(identifier: rawValue, title: title, options: [.foreground])
        case .resume, .retry:
            return UNNotificationAction(identifier: rawValue, title: title, options: [.authenticationRequired])
        }
    }
}

/// Top-level `userInfo` keys in every Optio push payload (beside `aps`).
enum NotificationUserInfo {
    /// `optio://…` deep link for the tapped notification / OPEN action.
    static let url = "url"
    /// Object kind: `local` | `task` | `agent` | `host`.
    static let kind = "kind"
    /// Object id (also the `thread-id`).
    static let id = "id"
    /// Pull request URL for `TASK_PR_OPENED`.
    static let prUrl = "prUrl"
}

extension NotificationCategory {
    /// All categories, ready for `UNUserNotificationCenter.setNotificationCategories`.
    static var registrationSet: Set<UNNotificationCategory> {
        Set(allCases.map { cat in
            UNNotificationCategory(
                identifier: cat.rawValue,
                actions: cat.actions.map(\.unAction),
                intentIdentifiers: [],
                options: cat == .localNeedsYou || cat == .agentReply ? [.customDismissAction] : [])
        })
    }

    static func register() {
        UNUserNotificationCenter.current().setNotificationCategories(registrationSet)
    }
}
