import AppIntents
import Foundation
import WidgetKit

// Every intent returns a one-sentence dialog so it works headless on AirPods.

// MARK: - Get Things That Need Me

struct GetThingsThatNeedMeIntent: AppIntent {
    static let title: LocalizedStringResource = "Get Things That Need Me"
    static let description = IntentDescription("Lists the local terminals waiting on you, oldest first.")

    func perform() async throws -> some IntentResult & ReturnsValue<[TerminalEntity]> & ProvidesDialog {
        let api = try await IntentContext.api()
        let terms: [LocalTerminal]
        do { terms = try await api.listLocalTerminals(state: "running") } catch { throw error.intentFailure }
        let needs = terms
            .filter { $0.isAgentTerminal && $0.attentionState == .needsYou && !SnoozeStore.isSnoozed($0.id) }
            .sorted { ($0.lastActivityAt ?? "") < ($1.lastActivityAt ?? "") }
            .map(TerminalEntity.init)
        let dialog: IntentDialog
        switch needs.count {
        case 0: dialog = "Nothing needs you."
        case 1: dialog = "1 thing needs you: \(needs[0].directory)."
        default: dialog = "\(needs.count) things need you: \(siriList(needs.map(\.directory)))."
        }
        return .result(value: needs, dialog: dialog)
    }
}

// MARK: - Reply to Terminal

struct ReplyToTerminalIntent: AppIntent {
    static let title: LocalizedStringResource = "Reply to Terminal"
    static let description = IntentDescription("Types a line into a local terminal and presses Enter.")

    @Parameter(title: "Terminal") var terminal: TerminalEntity
    @Parameter(title: "Reply", requestValueDialog: "What should I type?") var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Reply \(\.$text) to \(\.$terminal)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        let line = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !line.isEmpty else { return .result(dialog: "Nothing to send.") }
        do { try await api.sendLocalTerminalInput(terminal.id, data: line + "\r") } catch { throw error.intentFailure }
        WidgetCenter.shared.reloadAllTimelines()
        return .result(dialog: "Sent to \(terminal.directory).")
    }
}

// MARK: - Send Message to Agent

struct SendMessageToAgentIntent: AppIntent {
    static let title: LocalizedStringResource = "Send Message to Agent"
    static let description = IntentDescription("Messages a persistent agent; it wakes and replies when done.")

    @Parameter(title: "Agent") var agent: AgentEntity
    @Parameter(title: "Message", requestValueDialog: "What should I tell them?") var text: String

    static var parameterSummary: some ParameterSummary {
        Summary("Tell \(\.$agent) \(\.$text)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return .result(dialog: "Nothing to send.") }
        do { try await api.sendPersistentAgentMessage(agent.id, body: body) } catch { throw error.intentFailure }
        RecentAgentSends.record(agent.id)
        return .result(dialog: "Told \(agent.name). You'll get a notification when they reply.")
    }
}

// MARK: - Run Blueprint / Job

struct RunBlueprintIntent: AppIntent {
    static let title: LocalizedStringResource = "Run Blueprint"
    static let description = IntentDescription("Spawns a terminal from an Optio Local blueprint.")

    @Parameter(title: "Blueprint") var blueprint: BlueprintEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Run \(\.$blueprint)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        if blueprint.spawnMode == "auto" {
            try await requestConfirmation(result: .result(dialog: "Run \(blueprint.name) now? It starts immediately on your machine."), confirmationActionName: .go)
        }
        do {
            let t = try await api.spawnLocalBlueprint(blueprint.id)
            WidgetCenter.shared.reloadAllTimelines()
            let held = t.state == .pending
            return .result(dialog: held ? "\(blueprint.name) is ready — start it from Optio." : "Started \(blueprint.name) in \((t.dir as NSString).lastPathComponent).")
        } catch { throw error.intentFailure }
    }
}

struct RunJobIntent: AppIntent {
    static let title: LocalizedStringResource = "Run Job"
    static let description = IntentDescription("Starts a run of a standalone Job.")

    @Parameter(title: "Job") var job: JobEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Run \(\.$job)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        try await requestConfirmation(result: .result(dialog: "Run \(job.name) now?"), confirmationActionName: .go)
        do {
            _ = try await api.runJob(job.id, params: nil)
            WidgetCenter.shared.reloadAllTimelines()
            return .result(dialog: "Started \(job.name).")
        } catch { throw error.intentFailure }
    }
}

// MARK: - Retry Task

struct RetryTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Retry Task"
    static let description = IntentDescription("Retries a failed task. Without a task, retries the most recent failure.")

    @Parameter(title: "Task") var task: TaskEntity?

    static var parameterSummary: some ParameterSummary {
        Summary("Retry \(\.$task)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        let target: TaskEntity
        if let task {
            target = task
        } else {
            let failed: [TaskRow]
            do { failed = try await api.listTasks(state: "failed", limit: 1) } catch { throw error.intentFailure }
            guard let last = failed.first else { return .result(dialog: "No failed tasks to retry.") }
            target = TaskEntity(last)
        }
        do { try await api.retryTask(target.id) } catch { throw error.intentFailure }
        return .result(dialog: "Retrying \(target.title).")
    }
}

// MARK: - Follow Task

struct FollowTaskIntent: AppIntent {
    static let title: LocalizedStringResource = "Follow Task"
    static let description = IntentDescription("Adds a task to the lock-screen Watch until it merges or fails.")

    @Parameter(title: "Task") var task: TaskEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Follow \(\.$task)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        if !FollowedTasks.contains(task.id) { FollowedTasks.toggle(task.id) }
        WidgetCenter.shared.reloadAllTimelines()
        return .result(dialog: "Following \(task.title) on your lock screen.")
    }
}

// MARK: - Kill Terminal

struct KillTerminalIntent: AppIntent {
    static let title: LocalizedStringResource = "Kill Terminal"
    static let description = IntentDescription("Stops a local terminal's process (SIGTERM).")

    @Parameter(title: "Terminal") var terminal: TerminalEntity

    static var parameterSummary: some ParameterSummary {
        Summary("Kill \(\.$terminal)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let api = try await IntentContext.api()
        try await requestConfirmation(result: .result(dialog: "Kill \(terminal.directory)? Unsaved work in that agent is lost."), confirmationActionName: .go)
        do { try await api.killLocalTerminal(terminal.id) } catch { throw error.intentFailure }
        WidgetCenter.shared.reloadAllTimelines()
        return .result(dialog: "Killed \(terminal.directory).")
    }
}

// MARK: - Open Needs You

struct OpenNeedsYouIntent: AppIntent {
    static let title: LocalizedStringResource = "Open What Needs Me"
    static let description = IntentDescription("Opens Optio at the oldest thing waiting on you.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        NotificationHandler.shared.deliver(url: DeepLink.needsYou.url)
        return .result(dialog: "Opening Optio.")
    }
}
