import Foundation
import SwiftUI
import UserNotifications
import WidgetKit

extension Notification.Name {
    /// Posted with an `optio://` URL as `object`; `MainTabView` forwards it to `AppRouter.handle(url:)`.
    static let optioOpenURL = Notification.Name("optio.openURL")
}

/// `UNUserNotificationCenterDelegate`: decides foreground presentation, runs
/// banner actions against the API, and routes taps into the app via deep links.
final class NotificationHandler: NSObject, UNUserNotificationCenterDelegate, @unchecked Sendable {
    static let shared = NotificationHandler()

    /// The object the user is currently looking at (set by detail screens through
    /// `.notificationSubject(kind:id:)`). Alerts for that object stay silent in-app.
    @MainActor var currentSubject: (kind: String, id: String)?

    /// A deep link received before the tab shell was mounted (cold launch from a tap).
    @MainActor private var pendingURL: URL?

    // MARK: - Routing

    @MainActor
    func deliver(url: URL) {
        // Signed in: the shell handles the post synchronously (and may `stash` it for a
        // server switch), so nothing is pending afterwards. Not signed in: keep it for
        // `flushPendingURL()` once the shell mounts.
        pendingURL = IntentContext.session?.phase == .signedIn ? nil : url
        NotificationCenter.default.post(name: .optioOpenURL, object: url)
    }

    /// Holds a link for the next `flushPendingURL()` without posting it now (used when
    /// the shell is about to be rebuilt for a server switch).
    @MainActor
    func stash(url: URL) {
        pendingURL = url
    }

    /// Re-posts a link that arrived while the app was still restoring its session.
    @MainActor
    func flushPendingURL() {
        guard let url = pendingURL else { return }
        pendingURL = nil
        Task { @MainActor in
            try? await Task.sleep(for: .milliseconds(600))
            NotificationCenter.default.post(name: .optioOpenURL, object: url)
        }
    }

    // MARK: - Delegate

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions {
        let content = notification.request.content
        guard let category = NotificationCategory(rawValue: content.categoryIdentifier) else {
            return [.list]
        }
        guard category.presentsInForeground else { return [.list] }
        let kind = content.userInfo[NotificationUserInfo.kind] as? String
        let id = content.userInfo[NotificationUserInfo.id] as? String
        let viewing = await MainActor.run { () -> Bool in
            guard let cur = currentSubject, let kind, let id else { return false }
            return cur.kind == kind && cur.id == id
        }
        return viewing ? [.list] : [.banner, .list, .sound]
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse) async {
        let content = response.notification.request.content
        let info = content.userInfo
        let kind = info[NotificationUserInfo.kind] as? String ?? ""
        let id = info[NotificationUserInfo.id] as? String ?? ""
        var url = (info[NotificationUserInfo.url] as? String).flatMap(URL.init(string:)) ?? fallbackURL(kind: kind, id: id)
        // APNs payloads don't say which paired server sent them; find the one that
        // knows this subject so the tap (and any action) lands on the right instance.
        let serverId = await resolveServer(kind: kind, id: id)
        let api = await MainActor.run { () -> APIClient? in
            guard let session = IntentContext.session else { return nil }
            if let serverId, serverId != session.activeServer?.id { return session.client(for: serverId) }
            return session.api
        }
        if let serverId, let u = url, DeepLink.serverId(in: u) == nil, let link = DeepLink(url: u) {
            url = link.url(server: serverId)
        }

        switch response.actionIdentifier {
        case UNNotificationDefaultActionIdentifier, NotificationAction.open.rawValue:
            if let url { await deliver(url: url) }

        case UNNotificationDismissActionIdentifier:
            break

        case NotificationAction.openPR.rawValue:
            if let pr = (info[NotificationUserInfo.prUrl] as? String).flatMap(URL.init(string:)) {
                await MainActor.run { UIApplication.shared.open(pr) }
            } else if let url {
                await deliver(url: url)
            }

        case NotificationAction.reply.rawValue:
            let text = (response as? UNTextInputNotificationResponse)?.userText.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !text.isEmpty else { return }
            switch kind {
            case "local":
                // PTYs take a carriage return as Enter (same as the in-app "Send + Enter").
                try? await api?.sendLocalTerminalInput(id, data: text + "\r")
            case "agent":
                try? await api?.sendPersistentAgentMessage(id, body: text)
                RecentAgentSends.record(id)
            default:
                if let url { await deliver(url: url) }
            }

        case NotificationAction.later.rawValue:
            await SnoozeStore.snooze(id, api: api)
            WidgetCenter.shared.reloadAllTimelines()

        case NotificationAction.resume.rawValue:
            switch kind {
            case "task": try? await api?.resumeTask(id, prompt: nil)
            case "agent": try? await api?.controlPersistentAgent(id, intent: .resume)
            default: break
            }

        case NotificationAction.retry.rawValue:
            if kind == "task" { try? await api?.retryTask(id) }

        default:
            if let url { await deliver(url: url) }
        }
    }

    /// The paired server that has `kind`/`id`, active first. Nil when there is only
    /// one server (nothing to disambiguate) or when none of them answers.
    private func resolveServer(kind: String, id: String) async -> String? {
        let servers = ServerRegistry.configured
        guard servers.count > 1, !id.isEmpty else { return nil }
        let path: String
        switch kind {
        case "local": path = "/api/local/terminals/\(id)"
        case "task": path = "/api/tasks/\(id)"
        case "agent": path = "/api/persistent-agents/\(id)"
        case "host": path = "/api/local/hosts/\(id)"
        default: return nil
        }
        for server in servers {
            guard let fetch = SharedFetch(server: server) else { continue }
            if (try? await fetch.raw("GET", path, query: [:], body: nil, timeout: 6)) != nil { return server.id }
        }
        return nil
    }

    private func fallbackURL(kind: String, id: String) -> URL? {
        guard !id.isEmpty else { return nil }
        switch kind {
        case "local": return DeepLink.local(id, compose: false).url
        case "task": return DeepLink.task(id).url
        case "agent": return DeepLink.agent(id, compose: false).url
        case "host": return DeepLink.section("local").url
        default: return nil
        }
    }
}

// MARK: - View helper

private struct NotificationSubjectModifier: ViewModifier {
    let kind: String
    let id: String

    func body(content: Content) -> some View {
        content
            .onAppear { NotificationHandler.shared.currentSubject = (kind, id) }
            .onDisappear {
                if let cur = NotificationHandler.shared.currentSubject, cur.kind == kind, cur.id == id {
                    NotificationHandler.shared.currentSubject = nil
                }
            }
    }
}

extension View {
    /// Marks this screen as showing `kind`/`id` (`local` | `task` | `agent`), so
    /// push banners about that object are suppressed while it is on screen.
    func notificationSubject(kind: String, id: String) -> some View {
        modifier(NotificationSubjectModifier(kind: kind, id: id))
    }
}
