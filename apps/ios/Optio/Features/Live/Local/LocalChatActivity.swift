import Foundation

struct LocalChatActivity: Equatable {
    let title: String
    var active = false
    var symbol = "checkmark.circle"

    static func resolve(state: LocalTerminalState, attention: LocalAttentionState, connected: Bool,
                        hasPendingMessage: Bool, latestKind: LocalTranscriptKind?) -> Self {
        if state == .error { return Self(title: "Session failed", symbol: "exclamationmark.circle") }
        if state == .exited { return Self(title: "Session finished") }
        if !connected { return Self(title: "Reconnecting · status may be out of date", symbol: "wifi.exclamationmark") }
        if state == .pending || state == .launching { return Self(title: "Starting session…", active: true) }
        if attention == .working {
            let title: String
            switch latestKind {
            case .thinking: title = "Thinking…"
            case .text: title = "Responding…"
            default: title = "Working…"
            }
            return Self(title: title, active: true)
        }
        if hasPendingMessage { return Self(title: "Waiting for the agent to pick up your message", symbol: "clock") }
        if attention == .needsYou { return Self(title: "Waiting for you", symbol: "person.crop.circle") }
        if attention == .idle { return Self(title: "Ready for your next message") }
        return Self(title: "Waiting for agent status", symbol: "clock")
    }
}
