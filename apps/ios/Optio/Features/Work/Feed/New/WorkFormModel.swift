import Foundation

// Port of `apps/web/src/components/work-form/model.ts`. Pure data + pure
// functions; the SwiftUI form and the submitter sit on top. Keep the names
// aligned with the web so the two can be diffed side by side.
//
// One piece of work, five attributes. Every kind of work Optio runs — a Task that
// opens a PR, a Job, a scheduled blueprint, a Local automation, an interactive
// terminal, a Persistent Agent — is a point in this space, and the storage
// row it becomes (`deriveKind`) is a pure function of the point.
//
//   WHEN   what starts it: now, a schedule, a webhook, a ticket, or a GitHub /
//          Slack / Linear event (events run on your machine)
//   WHERE  an Optio pod (with one of your repos, or none) or your own machine
//          (in the directory as it is, or on a new branch that becomes a PR)
//   WHO    a terminal with no agent, or an agent runtime and its parameters
//   WHAT   the prompt (agents only), with the trigger's params available
//   THEN   what happens when a turn ends: exits / waits for me / persistent agent
//   NAME   yours, or "Job N" / "Terminal N" for its kind

enum WorkForm {
    // MARK: - Vocabulary

    enum Then: String, CaseIterable, Hashable, Sendable {
        case exits
        case waitsForMe = "waits-for-me"
        case waitsForMessages = "waits-for-messages"
    }

    enum TriggerType: String, CaseIterable, Hashable, Sendable {
        case manual, schedule, webhook, ticket
    }

    enum EventTriggerType: String, CaseIterable, Hashable, Sendable {
        case github, slack, linear
    }

    enum WhenType: String, CaseIterable, Hashable, Sendable {
        case manual, schedule, webhook, ticket, github, slack, linear

        var isEvent: Bool { EventTriggerType(rawValue: rawValue) != nil }
        var event: EventTriggerType? { EventTriggerType(rawValue: rawValue) }
        var trigger: TriggerType? { TriggerType(rawValue: rawValue) }

        var label: String {
            switch self {
            case .manual: return "Now"
            case .schedule: return "Schedule"
            case .webhook: return "Webhook"
            case .ticket: return "Ticket"
            case .github: return "GitHub"
            case .slack: return "Slack"
            case .linear: return "Linear"
            }
        }

        var systemImage: String {
            switch self {
            case .manual: return "play"
            case .schedule: return "clock"
            case .webhook: return "antenna.radiowaves.left.and.right"
            case .ticket: return "ticket"
            case .github: return "chevron.left.forwardslash.chevron.right"
            case .slack: return "number"
            case .linear: return "bolt"
            }
        }
    }

    enum TicketSource: String, CaseIterable, Hashable, Sendable {
        case github, linear, jira, notion
        var label: String { rawValue.prefix(1).uppercased() + rawValue.dropFirst() }
    }

    enum Where: String, CaseIterable, Hashable, Sendable {
        case cluster, local
    }

    enum LocalSessionMode: String, Hashable, Sendable {
        case headless, interactive
    }

    enum PodLifecycle: String, CaseIterable, Hashable, Sendable {
        case sticky
        case alwaysOn = "always-on"
        case onDemand = "on-demand"

        var label: String {
            switch self {
            case .sticky: return "Sticky"
            case .alwaysOn: return "Always on"
            case .onDemand: return "On demand"
            }
        }

        var hint: String {
            switch self {
            case .sticky: return "The pod stays warm for a while after each turn, then goes away until the next wake."
            case .alwaysOn: return "The pod never goes away — fastest wake, highest cost."
            case .onDemand: return "A fresh pod for every turn — slowest wake, nothing idle."
            }
        }
    }

    /// `TriggerConfig` in trigger-selector.tsx.
    struct TriggerConfig: Hashable, Sendable {
        var type: TriggerType = .manual
        var cronExpression: String?
        var webhookPath: String?
        var ticketSource: TicketSource?
        var ticketLabels: [String]?

        static let manual = TriggerConfig(type: .manual)
    }

    /// Event-trigger config for a Local automation, in the shape
    /// `/api/local/blueprints/:id/triggers` stores.
    struct EventTrigger: Hashable, Sendable {
        var type: EventTriggerType
        var config: [String: AnyCodable]

        static func `default`(_ type: EventTriggerType) -> EventTrigger {
            EventTrigger(type: type, config: defaultEventConfig(type))
        }
    }

    static func defaultEventConfig(_ type: EventTriggerType) -> [String: AnyCodable] {
        switch type {
        case .github: return ["events": .array([.string("review_requested"), .string("mentioned")]), "login": .string("")]
        case .slack: return ["channelId": .string(""), "mentionOnly": .bool(false)]
        case .linear: return ["events": .array([.string("assigned"), .string("mentioned")]), "user": .string("")]
        }
    }

    /// `RunLocationValue` in run-location-picker.tsx.
    struct RunLocation: Hashable, Sendable {
        var runTarget: Where = .cluster
        var localHostId = ""
        var localDir = ""
        var localSessionMode: LocalSessionMode = .headless

        static let cluster = RunLocation()
    }

    /// A model / provider option value (string or bool), keyed like the repo columns.
    enum OptionValue: Hashable, Sendable {
        case string(String)
        case bool(Bool)

        var stringValue: String? { if case .string(let s) = self { return s } else { return nil } }
        var boolValue: Bool? { if case .bool(let b) = self { return b } else { return nil } }
        var isBlank: Bool { if case .string(let s) = self { return s.isEmpty } else { return false } }
        var anyCodable: AnyCodable {
            switch self {
            case .string(let s): return .string(s)
            case .bool(let b): return .bool(b)
            }
        }
    }

    typealias AgentOptions = [String: OptionValue]

    struct AgentExtras: Hashable, Sendable {
        var slug = ""
        var podLifecycle: PodLifecycle = .sticky
        var systemPrompt = ""
        var agentsMd = ""
    }

    // MARK: - The draft

    struct Draft: Hashable, Sendable {
        var when: WhenType = .manual
        var trigger: TriggerConfig = .manual
        var event: EventTrigger = .default(.github)
        var location: RunLocation = .cluster
        /// Pod: one of your registered repos (vs. no repo). Machine: work on a new
        /// branch that becomes a PR (vs. the directory as it is). Either way it
        /// means "this work produces a PR".
        var withRepo = true
        var repoId = ""
        var repoUrl = ""
        var repoBranch = "main"
        /// `""` = a terminal with no agent.
        var runtime = "claude-code"
        var agentOptions: AgentOptions = [:]
        var prompt = ""
        var then: Then = .exits
        var agent = AgentExtras()
        /// Blank = "<Kind> N" (see `kindWord`).
        var name = ""
        var description = ""
        var priority = 100
        var maxRetries = 3
        var dependsOn: [String] = []

        static let empty = Draft()
    }

    // MARK: - Runtimes

    struct Runtime: Hashable, Sendable {
        let value: String
        let label: String
    }

    static let runtimes: [Runtime] = [
        Runtime(value: "claude-code", label: "Claude Code"),
        Runtime(value: "codex", label: "OpenAI Codex"),
        Runtime(value: "copilot", label: "GitHub Copilot"),
        Runtime(value: "gemini", label: "Google Gemini"),
        Runtime(value: "cursor", label: "Cursor"),
        Runtime(value: "opencode", label: "OpenCode"),
        Runtime(value: "openclaw", label: "OpenClaw"),
    ]

    static let terminal = ""

    static func runtimeLabel(_ runtime: String) -> String {
        if runtime == terminal { return "terminal" }
        return runtimes.first { $0.value == runtime }?.label ?? runtime
    }

    /// `toLocalAgentKind` in packages/shared: the CLIs the daemon can launch.
    static let localAgentKinds: Set<String> = ["claude-code", "codex", "cursor", "gemini", "opencode"]
    static func runsLocally(_ runtime: String) -> Bool { localAgentKinds.contains(runtime) }

    /// `providerForAgentType` in packages/shared/src/agent-options.
    static func provider(for runtime: String) -> String {
        switch runtime {
        case "codex": return "openai"
        case "gemini": return "gemini"
        case "copilot": return "copilot"
        case "opencode": return "opencode"
        case "openclaw": return "openclaw"
        case "cursor": return "cursor"
        default: return "anthropic"
        }
    }

    /// `ProviderCatalog.modelField` per provider — the repo column the model lives in.
    /// Known statically so the form can carry a model even when the catalog fetch fails.
    static func modelField(forProvider provider: String) -> String {
        switch provider {
        case "openai", "copilot": return "copilotModel"
        case "gemini": return "geminiModel"
        case "opencode": return "opencodeModel"
        case "openclaw": return "openclawModel"
        case "cursor": return "cursorModel"
        default: return "claudeModel"
        }
    }

    static func modelField(forRuntime runtime: String) -> String { modelField(forProvider: provider(for: runtime)) }

    /// A stored alias ("opus") shows as the model it resolves to (`agent-options-picker.tsx`).
    static func resolveModel(_ raw: String, aliases: [String: String]?) -> String {
        aliases?[raw] ?? raw
    }

    // MARK: - Presets

    struct Preset: Identifiable, Sendable {
        let id: String
        let label: String
        let hint: String
        let systemImage: String
        let apply: @Sendable (Draft) -> Draft
    }

    static let presets: [Preset] = [
        Preset(id: "pr", label: "Open a PR", hint: "An agent changes a repo on a branch and opens a pull request.", systemImage: "arrow.triangle.pull") { d in
            var d = d
            d.when = .manual
            d.trigger = .manual
            d.location.runTarget = .cluster
            d.withRepo = true
            if d.runtime.isEmpty { d.runtime = "claude-code" }
            d.agentOptions = [:]
            d.then = .exits
            return d
        },
        Preset(id: "chat", label: "Interactive chat", hint: "An agent session on your machine you can type into.", systemImage: "bubble.left.and.text.bubble.right") { d in
            var d = d
            d.when = .manual
            d.trigger = .manual
            d.location.runTarget = .local
            d.location.localSessionMode = .interactive
            d.withRepo = false
            if d.runtime.isEmpty { d.runtime = "claude-code" }
            d.agentOptions = [:]
            d.then = .waitsForMe
            return d
        },
        Preset(id: "schedule", label: "Scheduled run", hint: "An agent runs on a cron with no repo and exits.", systemImage: "clock") { d in
            var d = d
            d.when = .schedule
            d.trigger = TriggerConfig(type: .schedule, cronExpression: "0 9 * * *")
            d.location.runTarget = .cluster
            d.withRepo = false
            if d.runtime.isEmpty { d.runtime = "claude-code" }
            d.agentOptions = [:]
            d.then = .exits
            return d
        },
        Preset(id: "agent", label: "Persistent agent", hint: "A named agent that keeps memory and wakes on messages.", systemImage: "cpu") { d in
            var d = d
            d.when = .manual
            d.trigger = .manual
            d.location.runTarget = .cluster
            d.withRepo = false
            if d.runtime.isEmpty { d.runtime = "claude-code" }
            d.agentOptions = [:]
            d.then = .waitsForMessages
            return d
        },
    ]

    static func preset(_ id: String) -> Preset? { presets.first { $0.id == id } }

    // MARK: - Trigger params

    /// The `{{param}}`s a prompt can use, per trigger.
    static let triggerParams: [WhenType: [String]] = [
        .manual: [],
        .schedule: [],
        .webhook: [],
        .ticket: ["ticketSource", "ticketExternalId", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"],
        .github: ["event", "kind", "repo", "repoUrl", "number", "title", "body", "url", "author", "headBranch", "baseBranch", "commentBody", "commentUrl"],
        .slack: ["channelId", "userId", "text", "ts", "threadTs", "permalink"],
        .linear: ["event", "identifier", "title", "description", "url", "labels", "teamKey", "assignee", "priority", "state", "commentBody", "commentUrl", "actor", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"],
    ]

    static func triggerParams(_ when: WhenType) -> [String] { triggerParams[when] ?? [] }

    // MARK: - Cron / webhook helpers (trigger-selector.tsx)

    struct CronPreset: Hashable, Sendable { let label: String; let expr: String }

    static let cronPresets: [CronPreset] = [
        CronPreset(label: "Every hour", expr: "0 * * * *"),
        CronPreset(label: "Every 6h", expr: "0 */6 * * *"),
        CronPreset(label: "Daily 09:00 UTC", expr: "0 9 * * *"),
        CronPreset(label: "Weekdays 09:00 UTC", expr: "0 9 * * 1-5"),
        CronPreset(label: "Mon 09:00 UTC", expr: "0 9 * * 1"),
    ]

    static func cronIsValid(_ expr: String?) -> Bool {
        guard let expr else { return false }
        return expr.split(whereSeparator: { $0.isWhitespace }).count == 5
    }

    static func randomWebhookPath() -> String {
        let alphabet = Array("abcdefghijklmnopqrstuvwxyz0123456789")
        return "hook-" + String((0..<8).map { _ in alphabet.randomElement()! })
    }

    // MARK: - Event kinds (local/automations-section.tsx)

    struct EventKind: Hashable, Sendable {
        let value: String
        let label: String
        let personal: Bool
    }

    static let githubKinds: [EventKind] = [
        EventKind(value: "review_requested", label: "Review requested from me", personal: true),
        EventKind(value: "mentioned", label: "I'm @-mentioned", personal: true),
        EventKind(value: "assigned", label: "Assigned to me", personal: true),
        EventKind(value: "pr_opened", label: "Any PR opened", personal: false),
        EventKind(value: "issue_opened", label: "Any issue opened", personal: false),
    ]

    static let linearKinds: [EventKind] = [
        EventKind(value: "assigned", label: "Assigned to me", personal: true),
        EventKind(value: "mentioned", label: "I'm @-mentioned", personal: true),
        EventKind(value: "created", label: "Any issue created", personal: false),
        EventKind(value: "labeled", label: "A label is added", personal: false),
    ]

    // MARK: - Derived facts

    static func isLocal(_ d: Draft) -> Bool { d.location.runTarget == .local }
    static func isTriggered(_ d: Draft) -> Bool { d.when != .manual }

    struct Choice<T: Hashable>: Hashable {
        let value: T
        /// Why it can't be picked right now, if it can't.
        var disabled: String? = nil
        var isEnabled: Bool { disabled == nil }
    }

    /// Pod or machine. Every trigger — a schedule, a webhook, a ticket, an event — works with either.
    static func whereOptions(_ d: Draft) -> [Choice<Where>] {
        [Choice(value: .cluster), Choice(value: .local)]
    }

    /// The terminal and the runtimes the picked Where allows.
    static func runtimeOptions(_ d: Draft) -> [Choice<String>] {
        let local = isLocal(d)
        let terminalDisabled: String? =
            !local && !d.withRepo ? "A pod terminal is attached to a repo — pick a repository above."
            : !local && isTriggered(d) ? "A pod terminal is opened by hand — pick Now above."
            : nil
        var out = [Choice(value: terminal, disabled: terminalDisabled)]
        for r in runtimes {
            out.append(Choice(value: r.value, disabled: local && !runsLocally(r.value) ? "runs in pods only" : nil))
        }
        return out
    }

    /// Exit conditions, given everything above them.
    static func thenOptions(_ d: Draft) -> [Choice<Then>] {
        let local = isLocal(d)
        let isTerminal = d.runtime == terminal
        let waitsForMe: String? =
            !local && !d.withRepo ? "A pod terminal is attached to a repo — pick a repository above."
            : !local && isTriggered(d) ? "A pod terminal is opened by hand. On your machine, triggers can open one."
            : nil
        let messages: String? =
            local ? "Persistent agents run in an Optio pod so they stay reachable."
            : isTerminal ? "A persistent agent needs an agent runtime."
            : d.withRepo ? "Persistent agents don't attach to a repo — pick No repo above."
            : nil
        return [
            Choice(value: .exits, disabled: isTerminal ? "A terminal with no agent waits for you." : nil),
            Choice(value: .waitsForMe, disabled: waitsForMe),
            Choice(value: .waitsForMessages, disabled: messages),
        ]
    }

    private static func firstEnabled<T>(_ choices: [Choice<T>], current: T) -> T {
        if let keep = choices.first(where: { $0.value == current && $0.isEnabled }) { return keep.value }
        if let first = choices.first(where: { $0.isEnabled }) { return first.value }
        return current
    }

    /// Snap a draft back into the space its upstream answers allow, after any
    /// change. Upstream wins: When over Where over Who over Then.
    static func normalize(_ d: Draft) -> Draft {
        var next = d
        let target = firstEnabled(whereOptions(next), current: next.location.runTarget)
        if target != next.location.runTarget { next.location.runTarget = target }
        // A runtime that can't run here falls back to the first agent that can —
        // never silently to a bare terminal, which is a different kind of work.
        let options = runtimeOptions(next)
        let runtime = options.contains { $0.value == next.runtime && $0.isEnabled }
            ? next.runtime
            : firstEnabled(options.filter { $0.value != terminal }, current: next.runtime)
        if runtime != next.runtime {
            next.runtime = runtime
            next.agentOptions = [:]
        }
        let then = firstEnabled(thenOptions(next), current: next.then)
        if then != next.then { next.then = then }
        let mode: LocalSessionMode = next.then == .waitsForMe ? .interactive : .headless
        if next.location.localSessionMode != mode { next.location.localSessionMode = mode }
        return next
    }

    /// Which agent parameters the run will honor. Every pod run — a Task (over
    /// the repo's defaults), a Job, a persistent agent — reads the runtime's full
    /// provider option set. On your machine the daemon passes the CLI just a
    /// model; its other settings come from the machine's own config.
    static func fullOptionsApply(_ d: Draft) -> Bool {
        !isLocal(d) && d.runtime != terminal
    }

    /// The repo's configured values for this runtime's options, to seed the picker.
    /// `keys` = the catalog's model field plus its option keys.
    static func optionsFromRepo(runtime: String, repo: [String: AnyCodable]?, keys: [String]) -> AgentOptions {
        guard let repo, runtime != terminal else { return [:] }
        var out: AgentOptions = [:]
        for k in keys {
            if let s = repo[k]?.stringValue { out[k] = .string(s) }
            else if let b = repo[k]?.boolValue { out[k] = .bool(b) }
        }
        return out
    }

    /// A slug for a persistent agent, from its name.
    static func slugify(_ name: String) -> String {
        var out = ""
        var pendingDash = false
        for ch in name.lowercased() {
            if ch.isASCII, ch.isLetter || ch.isNumber {
                if pendingDash, !out.isEmpty { out.append("-") }
                pendingDash = false
                out.append(ch)
            } else {
                pendingDash = true
            }
        }
        return String(out.prefix(40))
    }

    /// `normalizeRepoUrl` in packages/shared: a checkout's remote as the API wants it.
    static func repoUrlFromRemote(_ remote: String?) -> String? {
        guard var u = remote?.trimmingCharacters(in: .whitespacesAndNewlines), !u.isEmpty else { return nil }
        if let m = u.firstMatch(of: /^[\w-]+@([^:]+):(.+)$/) {
            u = "https://\(m.1)/\(m.2)"
        }
        if let m = u.firstMatch(of: /^ssh:\/\/[^@]+@([^:\/]+)(?::\d+)?\/(.+)$/) {
            u = "https://\(m.1)/\(m.2)"
        }
        u = u.replacing(/^https?:\/\//.ignoresCase(), with: "https://")
        if !u.hasPrefix("https://") { u = "https://" + u }
        u = u.replacing(/\/+$/, with: "")
        u = u.replacing(/\.git$/, with: "")
        u = u.replacing(/\/+$/, with: "")
        u = u.lowercased()
        u = u.replacing(/\/+$/, with: "")
        return u
    }

    /// `github.com/owner/repo` for display.
    static func shortRepo(_ repoUrl: String) -> String {
        (repoUrlFromRemote(repoUrl) ?? repoUrl).replacing(/^https:\/\//, with: "")
    }

    // MARK: - Kind: the storage row a draft becomes

    enum Kind: String, Hashable, Sendable {
        case repoTask = "repo-task"           // tasks (one-shot, opens a PR)
        case repoBlueprint = "repo-blueprint" // task_configs + trigger
        case standalone                       // workflows (+ trigger, or run now)
        case localBlueprint = "local-blueprint" // local_blueprints + trigger
        case localTerminal = "local-terminal" // local_terminals (interactive, on a machine)
        case podSession = "pod-session"       // interactive_sessions (interactive, in a repo pod)
        case persistentAgent = "persistent-agent" // persistent_agents
    }

    /// The bare word for a kind, for default names ("Job 12").
    static func kindWord(_ kind: Kind) -> String {
        switch kind {
        case .repoTask, .repoBlueprint: return "Task"
        case .standalone: return "Job"
        case .localBlueprint: return "Automation"
        case .localTerminal: return "Terminal"
        case .podSession: return "Session"
        case .persistentAgent: return "Agent"
        }
    }

    static func deriveKind(_ d: Draft) -> Kind {
        if d.then == .waitsForMessages { return .persistentAgent }
        if d.then == .waitsForMe {
            if !isLocal(d) { return .podSession }
            return isTriggered(d) ? .localBlueprint : .localTerminal
        }
        if d.withRepo { return isTriggered(d) ? .repoBlueprint : .repoTask }
        return .standalone
    }

    // MARK: - The sentence

    enum SentenceField: String, Hashable, Sendable {
        case checkout, repo, machine, prompt, cron, webhook
    }

    enum SentencePart: Hashable, Sendable {
        case text(String)
        case missing(String, SentenceField)

        var field: SentenceField? { if case .missing(_, let f) = self { return f } else { return nil } }
    }

    struct Context: Sendable {
        var repoName: String? = nil
        var machineName: String? = nil
    }

    static let cronWords: [String: String] = [
        "0 * * * *": "every hour",
        "0 */6 * * *": "every 6 hours",
        "0 9 * * *": "daily at 09:00 UTC",
        "0 9 * * 1-5": "weekdays at 09:00 UTC",
        "0 9 * * 1": "Mondays at 09:00 UTC",
    ]

    private static func whenPhrase(_ d: Draft) -> [SentencePart] {
        switch d.when {
        case .manual:
            if d.then == .waitsForMessages { return [.text("Woken by messages,")] }
            return [.text(d.then == .exits ? "Started now," : "Opened now,")]
        case .schedule:
            let cron = d.trigger.cronExpression?.trimmingCharacters(in: .whitespaces) ?? ""
            if !cronIsValid(cron) {
                return [.text("Running"), .missing("on a schedule", .cron), .text(",")]
            }
            return [.text("Running \(cronWords[cron] ?? "on `\(cron)`"),")]
        case .webhook:
            if let path = d.trigger.webhookPath, !path.isEmpty {
                return [.text("Started by a webhook at /api/hooks/\(path),")]
            }
            return [.text("Started by"), .missing("a webhook path", .webhook), .text(",")]
        case .ticket:
            return [.text("Started by \((d.trigger.ticketSource ?? .github).rawValue) tickets,")]
        case .github: return [.text("Started by GitHub events,")]
        case .slack: return [.text("Started by Slack messages,")]
        case .linear: return [.text("Started by Linear events,")]
        }
    }

    static func shortDir(_ dir: String) -> String {
        dir.replacing(/^\/Users\/[^\/]+|^\/home\/[^\/]+/, with: "~")
    }

    /// "Started now, a Claude Code run in an Optio pod with acme/app that
    /// opens a PR and exits when done." Missing pieces render as gaps that point
    /// at their field, so the sentence is also the validation.
    static func describe(_ d: Draft, _ ctx: Context = Context()) -> [SentencePart] {
        var parts = whenPhrase(d)
        let who = d.runtime == terminal ? "a terminal" : "a \(runtimeLabel(d.runtime))"
        // Plain English for the exit condition: a run finishes, a session waits
        // for you, an agent stays.
        let noun = d.then == .waitsForMessages ? "agent" : d.then == .waitsForMe ? "session" : "run"
        parts.append(.text(d.runtime == terminal ? who : "\(who) \(noun)"))

        if d.then == .waitsForMessages {
            parts.append(.text("in an Optio pod"))
        } else if isLocal(d) {
            parts.append(d.location.localHostId.isEmpty ? .missing("a machine", .machine) : .text("on \(ctx.machineName ?? "my machine")"))
            if d.location.localDir.isEmpty {
                parts.append(.missing(d.withRepo ? "a checkout" : "a directory", .checkout))
            } else {
                parts.append(.text("\(d.withRepo ? "on a new branch in" : "in") \(shortDir(d.location.localDir))"))
            }
        } else {
            parts.append(.text("in an Optio pod"))
            if d.withRepo {
                parts.append(d.repoUrl.isEmpty ? .missing("a repo", .repo) : .text("with \(ctx.repoName ?? d.repoUrl)"))
            }
        }

        switch d.then {
        case .exits: parts.append(.text(d.withRepo ? "that opens a PR and exits when done." : "that exits when done."))
        case .waitsForMe: parts.append(.text("that waits for you between turns."))
        case .waitsForMessages: parts.append(.text("that keeps its memory between turns."))
        }
        return parts
    }

    /// The sentence as one string (missing pieces in brackets) — for tests and accessibility.
    static func sentenceText(_ parts: [SentencePart]) -> String {
        parts.reduce(into: "") { acc, part in
            let t: String
            switch part {
            case .text(let s): t = s
            case .missing(let s, _): t = "[\(s)]"
            }
            if t.hasPrefix(",") || t.hasPrefix(".") { acc += t }
            else if acc.isEmpty { acc = t }
            else { acc += " " + t }
        }
    }

    /// What the sentence can't fill in, plus the prompt when the work needs one.
    static func missingFields(_ d: Draft, _ ctx: Context = Context()) -> [SentenceField] {
        var gaps = describe(d, ctx).compactMap(\.field)
        let kind = deriveKind(d)
        // A terminal you open by hand needs no prompt; everything an agent runs
        // unattended does.
        let adHocTerminal = kind == .podSession || kind == .localTerminal
        if !adHocTerminal, d.runtime != terminal, d.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            gaps.append(.prompt)
        }
        return gaps
    }

    // MARK: - Labels the form and the tests share

    static func submitLabel(_ d: Draft) -> String {
        if deriveKind(d) == .persistentAgent { return "Create agent" }
        if d.when != .manual { return "Save" }
        switch d.then {
        case .exits: return d.withRepo ? "Start work (opens a PR)" : "Start work"
        case .waitsForMe, .waitsForMessages: return "Open session"
        }
    }

    static func fieldLabel(_ f: SentenceField) -> String {
        switch f {
        case .checkout: return "checkout"
        case .repo: return "repo"
        case .machine: return "machine"
        case .prompt: return "prompt"
        case .cron: return "cron"
        case .webhook: return "webhook"
        }
    }
}
