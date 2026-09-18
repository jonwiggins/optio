import AppIntents

/// Siri / Shortcuts phrases (product brief §2h). Validated at compile time; every
/// phrase must mention `\(.applicationName)`.
struct OptioShortcuts: AppShortcutsProvider {
    static let shortcutTileColor: ShortcutTileColor = .purple

    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: GetThingsThatNeedMeIntent(),
            phrases: [
                "What needs me in \(.applicationName)",
                "What needs me in \(.applicationName)?",
                "Anything need me in \(.applicationName)",
                "Check \(.applicationName)",
            ],
            shortTitle: "What needs me",
            systemImageName: "exclamationmark.bubble")

        AppShortcut(
            intent: SendMessageToAgentIntent(),
            phrases: [
                "Tell \(\.$agent) in \(.applicationName)",
                "Message \(\.$agent) in \(.applicationName)",
                "Send a message to an agent in \(.applicationName)",
            ],
            shortTitle: "Tell an agent",
            systemImageName: "person.wave.2")

        AppShortcut(
            intent: ReplyToTerminalIntent(),
            phrases: [
                "Reply to \(\.$terminal) in \(.applicationName)",
                "Reply in \(.applicationName)",
            ],
            shortTitle: "Reply to a terminal",
            systemImageName: "terminal")

        AppShortcut(
            intent: RunBlueprintIntent(),
            phrases: [
                "Run \(\.$blueprint) in \(.applicationName)",
                "Run a blueprint in \(.applicationName)",
            ],
            shortTitle: "Run a blueprint",
            systemImageName: "doc.text")

        AppShortcut(
            intent: RunJobIntent(),
            phrases: [
                "Run the \(\.$job) job in \(.applicationName)",
                "Run a job in \(.applicationName)",
            ],
            shortTitle: "Run a job",
            systemImageName: "play.square")

        AppShortcut(
            intent: RetryTaskIntent(),
            phrases: [
                "Retry the last failed task in \(.applicationName)",
                "Retry a task in \(.applicationName)",
            ],
            shortTitle: "Retry a task",
            systemImageName: "arrow.clockwise")

        AppShortcut(
            intent: OpenNeedsYouIntent(),
            phrases: [
                "Open what needs me in \(.applicationName)",
                "Jump to what needs me in \(.applicationName)",
            ],
            shortTitle: "Jump to what needs me",
            systemImageName: "arrow.up.forward.app")
    }
}
