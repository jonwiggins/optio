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
//          GitLab / Slack / Linear / Jira / Pylon / PagerDuty / Sentry /
//          Alertmanager / Datadog event
//   WHERE  an Optio pod (with one of your repos, or none) or your own machine
//          (in the directory as it is, or on a new branch that becomes a PR)
//   WHO    a terminal with no agent, or an agent runtime and its parameters
//   WHAT   the prompt (agents only), with the trigger's params available
//   THEN   what happens when a turn ends: exits / works until the PR merges /
//          waits for me / persistent agent
//   NAME   yours, or "Job N" / "Terminal N" for its kind

enum WorkForm {
    // MARK: - Vocabulary

    enum Then: String, CaseIterable, Hashable, Sendable {
        case exits
        /// Opens a PR, then comes back for failing CI, conflicts and review feedback until it merges.
        case untilMerged = "until-merged"
        case waitsForMe = "waits-for-me"
        case waitsForMessages = "waits-for-messages"

        /// One headless run (or one per firing), not a session (web `isOneShot`).
        var isOneShot: Bool { self == .exits || self == .untilMerged }
    }

    enum TriggerType: String, CaseIterable, Hashable, Sendable {
        case manual, schedule, webhook, ticket
    }

    /// The event triggers (`EVENT_TRIGGER_TYPES` in @optio/shared). Pylon,
    /// Alertmanager and Datadog can't sign their deliveries, so each of their
    /// triggers has its own shared secret and URL (`selfSecret`).
    enum EventTriggerType: String, CaseIterable, Hashable, Sendable {
        case github, gitlab, slack, linear, jira, pylon, pagerduty, sentry, alertmanager, datadog

        /// `SELF_SECRET_TRIGGER_TYPES`: the trigger carries a secret, minted on save.
        var selfSecret: Bool { self == .pylon || self == .alertmanager || self == .datadog }
    }

    enum WhenType: String, CaseIterable, Hashable, Sendable {
        case manual, schedule, webhook, ticket, github, gitlab, slack, linear, jira, pylon, pagerduty, sentry, alertmanager, datadog

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
            case .gitlab: return "GitLab"
            case .slack: return "Slack"
            case .linear: return "Linear"
            case .jira: return "Jira"
            case .pylon: return "Pylon"
            case .pagerduty: return "PagerDuty"
            case .sentry: return "Sentry"
            case .alertmanager: return "Alertmanager"
            case .datadog: return "Datadog"
            }
        }

        var systemImage: String {
            switch self {
            case .manual: return "play"
            case .schedule: return "clock"
            case .webhook: return "antenna.radiowaves.left.and.right"
            case .ticket: return "ticket"
            case .github: return "chevron.left.forwardslash.chevron.right"
            case .gitlab: return "arrow.triangle.merge"
            case .slack: return "number"
            case .linear: return "bolt"
            case .jira: return "checklist"
            case .pylon: return "lifepreserver"
            case .pagerduty: return "bell.badge"
            case .sentry: return "exclamationmark.triangle"
            case .alertmanager: return "waveform.path.ecg"
            case .datadog: return "dog"
            }
        }

        /// The menu / row mark: GitHub, GitLab, Slack, Linear, Jira and Sentry
        /// show their brands; a ticket trigger shows its source's (see
        /// `ticketGlyph`). PagerDuty, Pylon, Alertmanager and Datadog have no
        /// brand asset yet, so they keep their symbols.
        var glyph: Glyph {
            switch self {
            case .github: return .brand(.github)
            case .gitlab: return .brand(.gitlab)
            case .slack: return .brand(.slack)
            case .linear: return .brand(.linear)
            case .jira: return .brand(.jira)
            case .sentry: return .brand(.sentry)
            default: return .symbol(systemImage)
            }
        }
    }

    enum TicketSource: String, CaseIterable, Hashable, Sendable {
        case github, gitlab, linear, jira, notion
        var label: String { Brand(provider: rawValue)?.label ?? rawValue.capitalized }
        var glyph: Glyph { Brand(provider: rawValue).map(Glyph.brand) ?? .symbol("ticket") }
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
        case .gitlab: return ["events": .array([.string("review_requested"), .string("mentioned")]), "username": .string("")]
        case .slack: return ["channelId": .string(""), "mentionOnly": .bool(false)]
        case .linear: return ["events": .array([.string("assigned"), .string("mentioned")]), "user": .string("")]
        case .jira: return ["events": .array([.string("assigned"), .string("mentioned")]), "user": .string("")]
        case .pylon: return ["events": .array([])]
        case .pagerduty: return ["events": .array([.string("incident.triggered")])]
        case .sentry: return ["events": .array([.string("issue_created")])]
        case .alertmanager: return ["events": .array([.string("firing")])]
        case .datadog: return ["events": .array([.string("triggered")])]
        }
    }

    /// The config key naming whom an event's personal kinds are about, per
    /// type (`login` / `username` / `user`); nil where no kind is about you.
    static func identityKey(_ type: EventTriggerType) -> String? {
        switch type {
        case .github: return "login"
        case .gitlab: return "username"
        case .linear, .jira: return "user"
        case .slack, .pylon, .pagerduty, .sentry, .alertmanager, .datadog: return nil
        }
    }

    /// The identity field's label and placeholder.
    static func identityField(_ type: EventTriggerType) -> (label: String, placeholder: String, mono: Bool) {
        switch type {
        case .github: return ("GitHub username", "octocat", true)
        case .gitlab: return ("GitLab username", "octocat", true)
        case .linear: return ("Linear user", "Jane Doe", false)
        case .jira: return ("Jira user", "jane@acme.com", false)
        default: return ("User", "", false)
        }
    }

    /// One comma-separated list filter an event trigger offers, by config key.
    struct ListFilter: Hashable, Sendable {
        let key: String
        let label: String
        let placeholder: String
    }

    /// The filters each event trigger takes beside its kinds (and identity).
    static func listFilters(_ type: EventTriggerType) -> [ListFilter] {
        switch type {
        case .github: return [
            ListFilter(key: "repos", label: "Repos", placeholder: "acme/api, acme/web"),
            ListFilter(key: "branches", label: "Branches", placeholder: "main, release/*"),
            ListFilter(key: "workflows", label: "Workflows", placeholder: "CI, Deploy"),
            ListFilter(key: "labels", label: "Labels", placeholder: "bug, optio"),
        ]
        case .gitlab: return [
            ListFilter(key: "projects", label: "Projects", placeholder: "acme/api, acme/web"),
            ListFilter(key: "branches", label: "Branches", placeholder: "main, release/*"),
            ListFilter(key: "labels", label: "Labels", placeholder: "bug, optio"),
        ]
        case .linear: return [
            ListFilter(key: "teams", label: "Teams", placeholder: "ENG, OPS"),
            ListFilter(key: "labels", label: "Labels", placeholder: "bug, optio"),
        ]
        case .jira: return [
            ListFilter(key: "projects", label: "Projects", placeholder: "ENG, OPS"),
            ListFilter(key: "labels", label: "Labels", placeholder: "bug, optio"),
            ListFilter(key: "issueTypes", label: "Issue types", placeholder: "Bug, Task"),
            ListFilter(key: "statuses", label: "Statuses", placeholder: "In Progress, Done"),
        ]
        case .pagerduty: return [
            ListFilter(key: "services", label: "Services", placeholder: "Checkout API, PROD1"),
        ]
        case .sentry: return [
            ListFilter(key: "projects", label: "Projects", placeholder: "api, web"),
            ListFilter(key: "environments", label: "Environments", placeholder: "production, staging"),
            ListFilter(key: "levels", label: "Levels", placeholder: "fatal, error"),
        ]
        case .alertmanager: return [
            ListFilter(key: "alertnames", label: "Alert names", placeholder: "HighErrorRate, DiskFull"),
            ListFilter(key: "severities", label: "Severities", placeholder: "critical, warning"),
            ListFilter(key: "receivers", label: "Receivers", placeholder: "optio"),
        ]
        case .datadog: return [
            ListFilter(key: "priorities", label: "Priorities", placeholder: "P1, P2"),
            ListFilter(key: "tags", label: "Tags", placeholder: "env:prod, service:api"),
            ListFilter(key: "monitors", label: "Monitors", placeholder: "Checkout latency, 123456"),
        ]
        case .slack, .pylon: return []
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
        /// `.untilMerged` only: merge the PR once it's green and approved (vs. keep
        /// it green and leave the merge to you).
        var mergeWhenReady = true
        var agent = AgentExtras()
        /// Blank = "<Kind> N" (see `kindWord`).
        var name = ""
        /// Recurring work: what each run is called, with the trigger's `{{param}}`s; blank = the name.
        var runName = ""
        var description = ""
        var priority = 100
        var maxRetries = 3
        var dependsOn: [String] = []
        /// Owner: the organization's, or your private work (pod work; a machine is always yours).
        var owner: ResourceOwner = .workspace
        /// Secret names the agent gets in its pod; only what's picked.
        var podSecrets: [String] = []

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
        Preset(id: "assign", label: "Assign to Optio", hint: "Issues labeled optio become PRs an agent works on until they merge.", systemImage: "arrow.triangle.merge") { d in
            var d = d
            d.when = .ticket
            d.trigger = TriggerConfig(type: .ticket, ticketSource: .github, ticketLabels: ["optio"])
            d.location.runTarget = .cluster
            d.withRepo = true
            if d.runtime.isEmpty { d.runtime = "claude-code" }
            d.agentOptions = [:]
            d.then = .untilMerged
            d.mergeWhenReady = true
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
        Preset(id: "terminal", label: "Terminal", hint: "A plain shell on your machine — no agent, no prompt.", systemImage: "terminal") { d in
            var d = d
            d.when = .manual
            d.trigger = .manual
            d.location.runTarget = .local
            d.location.localSessionMode = .interactive
            d.withRepo = false
            d.runtime = terminal
            d.agentOptions = [:]
            d.prompt = ""
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
        .github: ["event", "kind", "repo", "repoUrl", "number", "title", "body", "url", "author", "headBranch", "baseBranch", "commentBody", "commentUrl", "labels", "label", "ref", "sha", "commits", "compareUrl", "tag", "workflow", "conclusion", "merged"],
        .gitlab: ["event", "kind", "project", "projectUrl", "iid", "title", "body", "url", "author", "sourceBranch", "targetBranch", "commentBody", "commentUrl", "labels", "label", "ref", "sha", "commits", "compareUrl", "tag", "pipelineStatus", "action"],
        .slack: ["channelId", "userId", "text", "ts", "threadTs", "permalink", "botName"],
        .linear: ["event", "identifier", "title", "description", "url", "labels", "teamKey", "assignee", "priority", "state", "commentBody", "commentUrl", "actor", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"],
        .jira: ["event", "key", "title", "description", "url", "project", "projectName", "status", "previousStatus", "assignee", "priority", "labels", "issueType", "commentBody", "commentUrl", "actor", "ticketSource", "ticketExternalId", "ticketTitle", "ticketBody", "ticketUrl", "ticketLabels"],
        .pylon: ["event", "issueId", "issueNumber", "title", "body", "state", "url", "account", "requester", "assignee", "tags", "payload"],
        .pagerduty: ["event", "incidentId", "incidentNumber", "title", "url", "urgency", "priority", "service", "serviceId", "status", "assignees", "ticketSource", "ticketExternalId", "ticketTitle", "ticketUrl"],
        .sentry: ["event", "resource", "action", "issueId", "shortId", "title", "culprit", "level", "project", "projectName", "url", "environment", "status", "assignee", "count", "userCount", "firstSeen", "lastSeen", "actor", "alertRule", "ticketSource", "ticketExternalId", "ticketTitle", "ticketUrl"],
        .alertmanager: ["event", "status", "receiver", "groupKey", "title", "message", "alertnames", "severities", "count", "firing", "resolved", "externalUrl", "labels", "annotations", "alerts", "payload"],
        .datadog: ["event", "transition", "alertType", "eventId", "alertId", "title", "body", "link", "priority", "status", "tags", "hostname", "query", "scope", "metric", "org", "date", "payload"],
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
        EventKind(value: "pr_merged", label: "A PR is merged", personal: false),
        EventKind(value: "labeled", label: "A label is added", personal: false),
        EventKind(value: "push", label: "A branch is pushed", personal: false),
        EventKind(value: "release_published", label: "A release is published", personal: false),
        EventKind(value: "workflow_succeeded", label: "A workflow run passes", personal: false),
        EventKind(value: "workflow_failed", label: "A workflow run fails", personal: false),
    ]

    /// GitLab's kinds (`GITLAB_EVENT_KINDS`): GitHub's in GitLab's words.
    static let gitlabKinds: [EventKind] = [
        EventKind(value: "review_requested", label: "Review requested from me", personal: true),
        EventKind(value: "mentioned", label: "I'm @-mentioned", personal: true),
        EventKind(value: "assigned", label: "Assigned to me", personal: true),
        EventKind(value: "mr_opened", label: "Any MR opened", personal: false),
        EventKind(value: "mr_merged", label: "An MR is merged", personal: false),
        EventKind(value: "issue_opened", label: "Any issue opened", personal: false),
        EventKind(value: "labeled", label: "A label is added", personal: false),
        EventKind(value: "push", label: "A branch is pushed", personal: false),
        EventKind(value: "release_published", label: "A release is published", personal: false),
        EventKind(value: "pipeline_succeeded", label: "A pipeline passes", personal: false),
        EventKind(value: "pipeline_failed", label: "A pipeline fails", personal: false),
    ]

    static let linearKinds: [EventKind] = [
        EventKind(value: "assigned", label: "Assigned to me", personal: true),
        EventKind(value: "mentioned", label: "I'm @-mentioned", personal: true),
        EventKind(value: "created", label: "Any issue created", personal: false),
        EventKind(value: "labeled", label: "A label is added", personal: false),
    ]

    /// Jira Cloud issue / comment events (`JIRA_EVENT_KINDS`).
    static let jiraKinds: [EventKind] = [
        EventKind(value: "assigned", label: "Assigned to me", personal: true),
        EventKind(value: "mentioned", label: "I'm mentioned", personal: true),
        EventKind(value: "created", label: "Any issue created", personal: false),
        EventKind(value: "commented", label: "A comment is added", personal: false),
        EventKind(value: "transitioned", label: "Status changes", personal: false),
        EventKind(value: "labeled", label: "A label is added", personal: false),
    ]

    /// Sentry internal-integration webhooks (`SENTRY_EVENT_KINDS`); none is about you.
    static let sentryKinds: [EventKind] = [
        EventKind(value: "issue_created", label: "New issue", personal: false),
        EventKind(value: "issue_unresolved", label: "Issue regressed", personal: false),
        EventKind(value: "issue_resolved", label: "Issue resolved", personal: false),
        EventKind(value: "issue_assigned", label: "Issue assigned", personal: false),
        EventKind(value: "issue_archived", label: "Issue archived", personal: false),
        EventKind(value: "alert_triggered", label: "Issue alert fires", personal: false),
        EventKind(value: "metric_alert_critical", label: "Metric alert critical", personal: false),
        EventKind(value: "metric_alert_warning", label: "Metric alert warning", personal: false),
        EventKind(value: "metric_alert_resolved", label: "Metric alert resolved", personal: false),
    ]

    /// Alertmanager / Grafana alert groups (`ALERTMANAGER_EVENT_KINDS`).
    static let alertmanagerKinds: [EventKind] = [
        EventKind(value: "firing", label: "Alerts firing", personal: false),
        EventKind(value: "resolved", label: "Alerts resolved", personal: false),
    ]

    /// Datadog monitor transitions (`DATADOG_EVENT_KINDS`).
    static let datadogKinds: [EventKind] = [
        EventKind(value: "triggered", label: "Monitor triggered", personal: false),
        EventKind(value: "warning", label: "Monitor warning", personal: false),
        EventKind(value: "no_data", label: "No data", personal: false),
        EventKind(value: "recovered", label: "Monitor recovered", personal: false),
    ]

    /// PagerDuty Webhooks v3 incident events (`PAGERDUTY_EVENT_KINDS`); none is
    /// about you, so no identity is needed. Pylon's kinds are free text (no list).
    static let pagerdutyKinds: [EventKind] = [
        EventKind(value: "incident.triggered", label: "Incident triggered", personal: false),
        EventKind(value: "incident.acknowledged", label: "Incident acknowledged", personal: false),
        EventKind(value: "incident.unacknowledged", label: "Incident unacknowledged", personal: false),
        EventKind(value: "incident.resolved", label: "Incident resolved", personal: false),
        EventKind(value: "incident.escalated", label: "Incident escalated", personal: false),
        EventKind(value: "incident.reassigned", label: "Incident reassigned", personal: false),
        EventKind(value: "incident.delegated", label: "Incident delegated", personal: false),
        EventKind(value: "incident.reopened", label: "Incident reopened", personal: false),
        EventKind(value: "incident.priority_updated", label: "Priority updated", personal: false),
        EventKind(value: "incident.responder.added", label: "Responder added", personal: false),
        EventKind(value: "incident.responder.replied", label: "Responder replied", personal: false),
        EventKind(value: "incident.status_update_published", label: "Status update published", personal: false),
        EventKind(value: "incident.annotated", label: "Incident annotated", personal: false),
    ]

    /// The kinds an event trigger offers; empty for Slack and Pylon (free text).
    static func eventKinds(_ type: EventTriggerType) -> [EventKind] {
        switch type {
        case .github: return githubKinds
        case .gitlab: return gitlabKinds
        case .linear: return linearKinds
        case .jira: return jiraKinds
        case .pagerduty: return pagerdutyKinds
        case .sentry: return sentryKinds
        case .alertmanager: return alertmanagerKinds
        case .datadog: return datadogKinds
        case .slack, .pylon: return []
        }
    }

    /// Slack channel ids look like C0123ABCD (the API rejects anything else).
    static func isSlackChannelId(_ s: String) -> Bool {
        s.wholeMatch(of: /[A-Z][A-Z0-9]{5,}/) != nil
    }

    /// What an event trigger still needs before the API would accept it — the
    /// same rules the trigger routes enforce (`validateTriggerConfig`), checked
    /// up front so a rejected trigger never strands a half-created row.
    static func eventGaps(_ e: EventTrigger) -> [SentenceField] {
        let c = e.config
        let events = c["events"]?.arrayValue?.compactMap(\.stringValue) ?? []
        if e.type == .slack {
            return isSlackChannelId(c["channelId"]?.stringValue ?? "") ? [] : [.channel]
        }
        // Pylon's kinds are free text: empty means whatever the Pylon trigger sends.
        if e.type == .pylon { return [] }
        // No kinds checked would mean "every kind" to the matcher — make it a choice.
        if events.isEmpty { return [.events] }
        let kinds = eventKinds(e.type)
        let personal = events.contains { v in kinds.contains { $0.value == v && $0.personal } }
            // Linear's "only tickets from someone else" skips yours: it has to know you.
            || (e.type == .linear && c["othersOnly"]?.boolValue == true)
        let identity = identityKey(e.type).flatMap { c[$0]?.stringValue }?.trimmingCharacters(in: .whitespaces) ?? ""
        if personal, identity.isEmpty { return [.identity] }
        return []
    }

    /// "GitHub events" — what each event When is started by (web `EVENT_SOURCE_PHRASE`).
    static func eventSourcePhrase(_ type: EventTriggerType) -> String {
        switch type {
        case .github: return "GitHub events"
        case .gitlab: return "GitLab events"
        case .slack: return "Slack messages"
        case .linear: return "Linear events"
        case .jira: return "Jira events"
        case .pylon: return "Pylon events"
        case .pagerduty: return "PagerDuty incidents"
        case .sentry: return "Sentry alerts"
        case .alertmanager: return "Alertmanager alerts"
        case .datadog: return "Datadog monitors"
        }
    }

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

    /// The terminal and the runtimes the picked Where allows. A terminal is
    /// offered wherever some exit condition fits it (a command, a session).
    static func runtimeOptions(_ d: Draft) -> [Choice<String>] {
        let local = isLocal(d)
        var asTerminal = d
        asTerminal.runtime = terminal
        let terminalFits = thenOptions(asTerminal).contains { $0.isEnabled }
        var out = [Choice(value: terminal, disabled: terminalFits ? nil : "In a repo pod a trigger starts an agent — pick No repo to run a command instead.")]
        for r in runtimes {
            out.append(Choice(value: r.value, disabled: local && !runsLocally(r.value) ? "runs in pods only" : nil))
        }
        return out
    }

    /// Exit conditions, given everything above them (web `thenOptions`).
    static func thenOptions(_ d: Draft) -> [Choice<Then>] {
        let local = isLocal(d)
        let isTerminal = d.runtime == terminal
        // A terminal that exits runs a command — in a pod with no checkout, or
        // in the machine's directory as it is.
        let exits: String? =
            isTerminal && d.withRepo
            ? (local ? "A command runs in the directory as it is — pick “Current directory”, or an agent to work on a new branch."
                     : "A command runs without a checkout — pick No repo, or an agent to change the repo.")
            : nil
        let untilMerged: String? =
            isTerminal ? "Following a PR through needs an agent to fix what CI and reviewers find."
            : !d.withRepo ? (local ? "It works on the PR it opens — pick “On a new branch” above." : "It works on the PR it opens — pick a repository above.")
            : nil
        let waitsForMe: String? =
            !local && !d.withRepo ? "A pod terminal is attached to a repo — pick a repository above."
            : !local && isTriggered(d) ? "A pod terminal is opened by hand. On your machine, triggers can open one."
            : !local && !isTerminal && d.runtime != "claude-code" ? "A pod session chats with Claude Code — pick Terminal or Claude Code above."
            : nil
        // In a pod, with or without a repo (it then works in a checkout of it, turn after turn).
        let messages: String? =
            local ? "Persistent agents run in an Optio pod so they stay reachable."
            : isTerminal ? "A persistent agent needs an agent runtime."
            : nil
        return [
            Choice(value: .exits, disabled: exits),
            Choice(value: .untilMerged, disabled: untilMerged),
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

    // MARK: - PR follow-through

    /// The repo settings that decide what happens to a PR after it opens (web `RepoPrSettings`).
    struct RepoPrSettings: Hashable, Sendable {
        var autoResume: Bool? = nil
        var autoMerge: Bool? = nil
        var cautiousMode: Bool? = nil
        var reviewEnabled: Bool? = nil
        var reviewTrigger: String? = nil
        var maxAutoResumes: Int? = nil

        init(autoResume: Bool? = nil, autoMerge: Bool? = nil, cautiousMode: Bool? = nil,
             reviewEnabled: Bool? = nil, reviewTrigger: String? = nil, maxAutoResumes: Int? = nil) {
            self.autoResume = autoResume
            self.autoMerge = autoMerge
            self.cautiousMode = cautiousMode
            self.reviewEnabled = reviewEnabled
            self.reviewTrigger = reviewTrigger
            self.maxAutoResumes = maxAutoResumes
        }

        /// Reads the columns off a raw `/api/repos` row.
        init(row: [String: AnyCodable]) {
            self.init(
                autoResume: row["autoResume"]?.boolValue,
                autoMerge: row["autoMerge"]?.boolValue,
                cautiousMode: row["cautiousMode"]?.boolValue,
                reviewEnabled: row["reviewEnabled"]?.boolValue,
                reviewTrigger: row["reviewTrigger"]?.stringValue,
                maxAutoResumes: row["maxAutoResumes"]?.intValue
            )
        }
    }

    /// The server's cap when a repo sets none (`OPTIO_MAX_AUTO_RESUMES`' default).
    static let defaultMaxAutoResumes = 10

    /// One line of "What happens to the PR".
    struct FollowThroughStep: Hashable, Sendable, Identifiable {
        enum Key: String, Hashable, Sendable { case pr, review, ci, changes, merge, done }
        let key: Key
        let label: String
        let on: Bool
        var detail: String? = nil
        var id: Key { key }
    }

    /// The checklist, and whether it comes from the repo's settings (vs. this work's own).
    struct FollowThrough: Hashable, Sendable {
        let fromRepo: Bool
        let steps: [FollowThroughStep]
    }

    /// What happens to the PR once the agent opens it, step by step — the same
    /// rules the reconciler applies: a task's own follow-through (`.untilMerged`)
    /// wins over the repo's settings, review is always the repo's, and cautious
    /// mode (draft PRs) never merges. Nil when the work doesn't open a PR.
    static func followThrough(_ d: Draft, repo: RepoPrSettings?) -> FollowThrough? {
        guard d.withRepo, d.runtime != terminal, d.then.isOneShot else { return nil }
        let own = d.then == .untilMerged
        let resume = own ? true : repo?.autoResume == true
        let merge = own ? d.mergeWhenReady : repo?.autoMerge == true
        let cautious = repo?.cautiousMode == true
        let cap = repo?.maxAutoResumes ?? defaultMaxAutoResumes
        // The reconciler launches a review only on these two triggers.
        let reviewOn = repo?.reviewEnabled == true && (repo?.reviewTrigger == "on_pr" || repo?.reviewTrigger == "on_ci_pass")
        let resumes = "the agent picks it back up (up to \(cap) times)"
        let reviewDetail = !reviewOn ? "Off for this repo — turn it on in the repo's settings."
            : repo?.reviewTrigger == "on_pr" ? "As soon as the PR opens."
            : "Once CI passes."
        let mergeDetail = merge && cautious ? "Held back: this repo opens draft PRs (cautious mode), so a person merges."
            : merge ? "Squash-merges once checks pass and any blocking review is done."
            : "You merge it."
        return FollowThrough(fromRepo: !own, steps: [
            FollowThroughStep(key: .pr, label: cautious ? "Opens a draft PR" : "Opens a PR", on: true,
                              detail: "The agent's turn ends here; Optio watches CI and reviews from then on."),
            FollowThroughStep(key: .review, label: "A review agent reviews it", on: reviewOn, detail: reviewDetail),
            FollowThroughStep(key: .ci, label: "Fixes failing CI and merge conflicts", on: resume,
                              detail: resume ? "When checks fail or it conflicts, \(resumes)." : "It waits for you."),
            FollowThroughStep(key: .changes, label: "Addresses requested changes", on: resume,
                              detail: resume ? "When a reviewer requests changes, \(resumes)." : "It waits for you to resume it."),
            FollowThroughStep(key: .merge, label: "Merges when it's ready", on: merge && !cautious, detail: mergeDetail),
            FollowThroughStep(key: .done, label: "Completes on merge, fails if the PR is closed", on: true),
        ])
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
        case checkout, repo, machine, prompt, cron, webhook, identity, channel, events
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
            return [.text(d.then.isOneShot ? "Started now," : "Opened now,")]
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
            return [.text("Started by \((d.trigger.ticketSource ?? .github).label) tickets,")]
        case .github, .gitlab, .slack, .linear, .jira, .pylon, .pagerduty, .sentry, .alertmanager, .datadog:
            let source = eventSourcePhrase(d.event.type)
            guard let gap = eventGaps(d.event).first else { return [.text("Started by \(source),")] }
            let missing: SentencePart = gap == .channel ? .missing("in a channel", .channel)
                : gap == .events ? .missing("of some kind", .events)
                : .missing("about you", .identity)
            return [.text("Started by \(source)"), missing, .text(",")]
        }
    }

    /// "a Claude Code" / "an OpenAI Codex" (web `withArticle`).
    static func withArticle(_ noun: String) -> String {
        let vowel = noun.first.map { "aeiouAEIOU".contains($0) } ?? false
        return "\(vowel ? "an" : "a") \(noun)"
    }

    static func shortDir(_ dir: String) -> String {
        dir.replacing(/^\/Users\/[^\/]+|^\/home\/[^\/]+/, with: "~")
    }

    /// "Started now, a Claude Code run in an Optio pod with acme/app that
    /// opens a PR and exits when done." Missing pieces render as gaps that point
    /// at their field, so the sentence is also the validation.
    static func describe(_ d: Draft, _ ctx: Context = Context()) -> [SentencePart] {
        var parts = whenPhrase(d)
        let who = isCommand(d) ? "a command" : d.runtime == terminal ? "a terminal" : withArticle(runtimeLabel(d.runtime))
        // Plain English for the exit condition: a run finishes, a session waits
        // for you, an agent stays.
        let noun = d.then == .waitsForMessages ? "agent" : d.then == .waitsForMe ? "session" : "run"
        parts.append(.text(d.runtime == terminal ? who : "\(who) \(noun)"))

        if d.then == .waitsForMessages {
            parts.append(.text("in an Optio pod"))
            if d.withRepo {
                parts.append(d.repoUrl.isEmpty ? .missing("a repo", .repo) : .text("with \(ctx.repoName ?? d.repoUrl)"))
            }
        } else if isLocal(d) {
            parts.append(d.location.localHostId.isEmpty ? .missing("a machine", .machine) : .text("on \(ctx.machineName ?? "my machine")"))
            if d.location.localDir.isEmpty {
                parts.append(.missing(d.withRepo ? "a checkout" : "a directory", .checkout))
            } else {
                parts.append(.text("\(d.withRepo && d.runtime != terminal ? "on a new branch in" : "in") \(shortDir(d.location.localDir))"))
            }
        } else {
            parts.append(.text("in an Optio pod"))
            if d.withRepo {
                parts.append(d.repoUrl.isEmpty ? .missing("a repo", .repo) : .text("with \(ctx.repoName ?? d.repoUrl)"))
            }
        }

        switch d.then {
        case .exits:
            parts.append(.text(isCommand(d) ? "that runs and exits." : d.withRepo ? "that opens a PR and exits when done." : "that exits when done."))
        case .untilMerged:
            parts.append(.text(d.mergeWhenReady
                ? "that opens a PR and keeps working on it until it merges."
                : "that opens a PR and keeps it green until you merge it."))
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

    /// What the sentence can't fill in, plus the prompt (or command) when the work needs one.
    static func missingFields(_ d: Draft, _ ctx: Context = Context()) -> [SentenceField] {
        var gaps = describe(d, ctx).compactMap(\.field)
        // A terminal that opens a shell needs nothing to run; a command needs its
        // command; and everything an agent runs unattended needs a prompt. (An
        // agent terminal you open on your machine can start without one.)
        if asksForPrompt(d), d.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, deriveKind(d) != .localTerminal {
            gaps.append(.prompt)
        }
        return gaps
    }

    /// Whether the What section asks for anything: an agent's prompt, or a command to run.
    static func asksForPrompt(_ d: Draft) -> Bool {
        // A pod session starts empty: only its repo and name travel.
        if deriveKind(d) == .podSession { return false }
        return d.runtime != terminal || d.then == .exits
    }

    /// The What answer is a shell command (a terminal that runs and exits), not a prompt.
    static func isCommand(_ d: Draft) -> Bool { d.runtime == terminal && d.then == .exits }

    /// Recurring work names each run; a one-off run just takes the name (web `namesRuns`).
    static func namesRuns(_ d: Draft) -> Bool {
        switch deriveKind(d) {
        case .repoBlueprint, .localBlueprint: return true
        case .standalone: return isTriggered(d)
        default: return false
        }
    }

    // MARK: - Labels the form and the tests share

    static func submitLabel(_ d: Draft) -> String {
        if deriveKind(d) == .persistentAgent { return "Create agent" }
        if d.when != .manual { return "Save" }
        switch d.then {
        case .exits: return d.withRepo ? "Start work (opens a PR)" : "Start work"
        case .untilMerged: return "Start work (until merged)"
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
        case .identity: return "identity"
        case .channel: return "channel"
        case .events: return "events"
        }
    }
}
