import Foundation

/// Reconnect policy for the local terminal stream WS
/// (`/ws/local/terminals/:id/stream`). A port of the web's `stream-policy.ts`,
/// pure so it can be unit-tested apart from SwiftTerm/WebSocket plumbing.
///
/// Close codes the server uses:
/// - 4401 — WS authentication failed
/// - 4403 — not authorized for this terminal / missing role
/// - 4429 — per-IP connection limit
/// - 4503 — host (daemon) disconnected: transient, the daemon reconnects
/// - 1000/1005 — deliberate close (ours on dispose, or the server's after a
///   fatal error frame like "Terminal not found")
enum StreamPolicy {
    enum CloseAction: Equatable {
        case reconnect
        case stop(message: String?)
    }

    /// Close codes that no amount of retrying can fix, with a user-facing line.
    static let permanentCloseMessages: [Int: String] = [
        4401: "Authentication failed — sign in again.",
        4403: "You don't have permission to view this terminal.",
        4429: "Too many connections — close other Optio clients.",
    ]

    /// Decide what to do when the stream socket closes (the caller already
    /// bails before this on dispose).
    ///
    /// - Permanent rejections (auth/role/limit) stop with a message.
    /// - A terminal that has exited/errored stops silently: nothing more will
    ///   stream, and reconnecting would only risk wiping the history on screen.
    /// - `retryRequested` marks a close we initiated to recover from a retryable
    ///   error frame (e.g. "Host is offline"), so its 1000 must still reconnect.
    /// - Other normal closes (1000/1005) are deliberate — don't loop on them.
    /// - Everything else (4503 host blip, 1001 going away, 1006 abnormal) retries.
    static func closeAction(code: Int, terminalDead: Bool, retryRequested: Bool) -> CloseAction {
        if let permanent = permanentCloseMessages[code] { return .stop(message: permanent) }
        if terminalDead { return .stop(message: nil) }
        if retryRequested { return .reconnect }
        if code == 1000 || code == 1005 { return .stop(message: nil) }
        return .reconnect
    }

    /// States after which no further bytes will ever stream.
    static func isTerminalStateDead(_ state: LocalTerminalState) -> Bool {
        state == .exited || state == .error
    }
}
