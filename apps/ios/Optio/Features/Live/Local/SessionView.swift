import Foundation

/// Which face of a Local session is showing: the terminal (`screen`, labeled
/// "Terminal") or the conversation distilled from the agent's transcript
/// (`transcript`, labeled "Chat"). Port of the web's `session-view.ts` with
/// the phone's rule: Chat is the default whenever there is a conversation, live
/// or not — a phone is for reading and replying, not for driving a 160-column
/// TUI.
enum LocalSessionView: String, CaseIterable, Identifiable {
    case transcript, screen
    var id: String { rawValue }
}

enum LocalSessionViewRule {
    /// The view to show, or nil while it can't be decided yet. An explicit
    /// choice always wins. Otherwise: wait for the transcript fetch to settle
    /// (so SwiftTerm isn't mounted only to be swapped out a moment later), then
    /// show the conversation when there is one and the screen when there isn't
    /// (a plain shell, or an agent that hasn't said anything yet).
    static func resolve(choice: LocalSessionView?, hasTranscript: Bool, loaded: Bool) -> LocalSessionView? {
        if let choice { return choice }
        if !loaded { return nil }
        return hasTranscript ? .transcript : .screen
    }

    /// Whether the Chat ⇄ Terminal toggle is offered (`canShowChat` in
    /// `session-view.ts`): once there is a conversation, or for a live agent
    /// session whose agent writes one (Claude Code, Codex) before its first
    /// entry lands — Chat then shows its empty state and its composer.
    static func canShowChat(_ terminal: LocalTerminal, hasTranscript: Bool) -> Bool {
        if hasTranscript { return true }
        guard !LocalPresentation.isDead(terminal), case .agent(let p) = terminal.spec else { return false }
        return p.agent == .claudeCode || p.agent == .codex
    }
}
