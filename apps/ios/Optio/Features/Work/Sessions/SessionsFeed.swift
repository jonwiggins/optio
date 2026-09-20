import Foundation

// The unified Sessions feed: every kind of work Optio runs, projected onto the
// five attributes the New session form asks for (When / Where / Who / Then + a
// status), so one list and one overview can show them together.
//
// A straight port of `apps/web/src/lib/sessions-feed.ts`. The rows come from the
// per-kind endpoints (unified tasks, local terminals + automations, pod
// sessions, persistent agents) and are merged client-side; a server-side read
// model can replace `SessionsFeed.collect` without touching the screens.
// Pure — no networking — so `OptioTests/SessionsFeedTests.swift` mirrors the
// web's `sessions-feed.test.ts`.

enum SessionSource: String, Hashable, Sendable, CaseIterable {
    case repoTask = "repo-task"
    case repoBlueprint = "repo-blueprint"
    case standalone
    case localBlueprint = "local-blueprint"
    case localTerminal = "local-terminal"
    case podSession = "pod-session"
    case persistentAgent = "persistent-agent"
}

/// needs-you first, then live, then everything by recency (`STATUS_RANK`).
enum SessionStatus: Int, Hashable, Sendable, Comparable {
    case needsYou = 0, running, queued, waiting, scheduled, paused, failed, done

    static func < (a: SessionStatus, b: SessionStatus) -> Bool { a.rawValue < b.rawValue }

    static let active: Set<SessionStatus> = [.needsYou, .running, .queued, .waiting]

    /// The web's status id (`needs_you`, `running`, …).
    var id: String {
        switch self {
        case .needsYou: return "needs_you"
        case .running: return "running"
        case .queued: return "queued"
        case .waiting: return "waiting"
        case .scheduled: return "scheduled"
        case .paused: return "paused"
        case .failed: return "failed"
        case .done: return "done"
        }
    }

    var tone: Tone {
        switch self {
        case .needsYou: return .accent
        case .running: return .working
        case .queued: return .idle
        case .waiting: return .success
        case .scheduled, .paused, .done: return .idle
        case .failed: return .danger
        }
    }
}

/// Saved filters over the feed (`SessionView`).
enum SessionView: String, Hashable, Sendable, CaseIterable, Identifiable {
    case active, recurring, agents, history, all

    var id: String { rawValue }

    var label: String {
        switch self {
        case .active: return "Active"
        case .recurring: return "Recurring"
        case .agents: return "Agents"
        case .history: return "History"
        case .all: return "All"
        }
    }
}

/// Exit conditions (`Then` in `components/session-form/model.ts`).
enum SessionThen: String, Hashable, Sendable {
    case exits
    case waitsForMe = "waits-for-me"
    case waitsForMessages = "waits-for-messages"

    /// Chip copy (`session-row.tsx`).
    var label: String {
        switch self {
        case .exits: return "exits"
        case .waitsForMe: return "waits for me"
        case .waitsForMessages: return "persistent"
        }
    }

    var systemImage: String {
        switch self {
        case .exits: return "rectangle.portrait.and.arrow.right"
        case .waitsForMe: return "terminal"
        case .waitsForMessages: return "cpu"
        }
    }
}

struct SessionWhere: Hashable, Sendable {
    enum Target: String, Hashable, Sendable { case pod, machine }
    let target: Target
    let detail: String?

    /// Chip copy: the detail, or the generic place.
    var label: String { detail ?? (target == .pod ? "Optio pod" : "machine") }
    var systemImage: String { target == .machine ? "laptopcomputer" : "server.rack" }
}

/// Where a row leads: the existing per-kind detail screen (the web's `href`).
enum SessionDestination: Hashable, Sendable {
    case task(String)
    case blueprint(String)
    case job(String)
    /// One run under a job (`/jobs/:id/runs/:runId`) — where a just-started job lands.
    case jobRun(jobId: String, runId: String)
    case localTerminal(String)
    case localBlueprint(String)
    case podSession(String)
    case agent(String)
}

struct SessionRow: Identifiable, Hashable, Sendable {
    let key: String
    let source: SessionSource
    /// Id of the underlying row (`tasks.id`, `local_terminals.id`, …).
    let sourceId: String
    /// The web route, kept for parity with the TypeScript feed.
    let href: String
    let name: String
    /// What starts it, as a short label ("now", "on a trigger", "messages").
    let when: String
    let `where`: SessionWhere
    /// Runtime id, or "terminal".
    let who: String
    let then: SessionThen
    let status: SessionStatus
    let statusLabel: String
    /// Extra one-liner: PR link, attention reason, next fire…
    let note: String?
    let prUrl: String?
    /// ISO-8601 timestamp; sorted lexically like the web.
    let lastActivity: String?
    /// Definitions that spawn runs (blueprints, automations).
    let recurring: Bool
    /// Runs spawned from a definition / task config.
    let spawned: Bool

    var id: String { key }

    var destination: SessionDestination {
        switch source {
        case .repoTask: return .task(sourceId)
        case .repoBlueprint: return .blueprint(sourceId)
        case .standalone: return .job(sourceId)
        case .localTerminal: return .localTerminal(sourceId)
        case .localBlueprint: return .localBlueprint(sourceId)
        case .podSession: return .podSession(sourceId)
        case .persistentAgent: return .agent(sourceId)
        }
    }

    var whenSystemImage: String {
        switch when {
        case "now": return "play"
        case "messages": return "cpu"
        default: return "clock"
        }
    }

    /// Chip copy for Who (`runtimeLabel`).
    var whoLabel: String { who == "terminal" ? "terminal" : SessionsFeed.runtimeLabel(who) }
    var whoSystemImage: String { who == "terminal" ? "terminal" : "bolt" }
}

struct SessionCounts: Hashable, Sendable {
    var needsYou = 0
    var running = 0
    var waiting = 0
    var recurring = 0
    var agents = 0
}

// MARK: - Source rows

/// The per-kind rows as the endpoints return them. Every field is optional so a
/// server that adds or drops a column never breaks the merge (the web reads the
/// same rows as `any`).
enum SessionsFeed {
    /// `GET /api/tasks?type=all`: rows tagged `type: repo-task | repo-blueprint | standalone`.
    struct UnifiedRow: Decodable, Hashable, Sendable {
        var type: String?
        var id: String?
        var title: String?
        var name: String?
        var state: String?
        var enabled: Bool?
        var repoUrl: String?
        var agentType: String?
        var agentRuntime: String?
        var prUrl: String?
        var runTarget: String?
        var localHostId: String?
        var localDir: String?
        var metadata: Metadata?
        var createdAt: String?
        var updatedAt: String?

        struct Metadata: Decodable, Hashable, Sendable {
            var taskConfigId: String?
        }
    }

    /// `GET /api/local/terminals`.
    struct TerminalRow: Decodable, Hashable, Sendable {
        var id: String?
        var title: String?
        var state: String?
        var pendingReason: String?
        var attentionState: String?
        var attentionReason: String?
        var hostId: String?
        var dir: String?
        var spec: Spec?
        var spawnedBy: String?
        var blueprintId: String?
        var workflowRunId: String?
        var taskId: String?
        var lastActivityAt: String?
        var updatedAt: String?

        struct Spec: Decodable, Hashable, Sendable {
            var kind: String?
            var agent: String?
            var mode: String?
        }
    }

    /// `GET /api/local/blueprints`.
    struct BlueprintRow: Decodable, Hashable, Sendable {
        var id: String?
        var name: String?
        var agent: String?
        var hostId: String?
        var dir: String?
        var sessionMode: String?
        var enabled: Bool?
        var createdAt: String?
        var updatedAt: String?
    }

    /// `GET /api/sessions`.
    struct PodSessionRow: Decodable, Hashable, Sendable {
        var id: String?
        var repoUrl: String?
        var branch: String?
        var state: String?
        var lastActivityAt: String?
        var endedAt: String?
        var createdAt: String?
    }

    /// `GET /api/persistent-agents`.
    struct AgentRow: Decodable, Hashable, Sendable {
        var id: String?
        var slug: String?
        var name: String?
        var state: String?
        var agentRuntime: String?
        var lastTurnAt: String?
        var updatedAt: String?
        var createdAt: String?
    }

    /// `GET /api/local/hosts` (only the name is needed here).
    struct HostRow: Decodable, Hashable, Sendable {
        var id: String?
        var name: String?
    }

    struct Sources: Hashable, Sendable {
        var unified: [UnifiedRow] = []
        var localTerminals: [TerminalRow] = []
        var localBlueprints: [BlueprintRow] = []
        var podSessions: [PodSessionRow] = []
        var agents: [AgentRow] = []
        var hosts: [HostRow] = []
    }

    // MARK: Filters

    static func inView(_ row: SessionRow, _ view: SessionView) -> Bool {
        switch view {
        case .active: return SessionStatus.active.contains(row.status)
        case .recurring: return row.recurring
        case .agents: return row.source == .persistentAgent
        case .history: return row.status == .done || row.status == .failed
        case .all: return true
        }
    }

    /// needs-you first, then live, then everything by recency.
    static func sort(_ rows: [SessionRow]) -> [SessionRow] {
        rows.sorted { a, b in
            if a.status != b.status { return a.status < b.status }
            return (a.lastActivity ?? "") > (b.lastActivity ?? "")
        }
    }

    /// Free-text search over name, place, agent, status and note (`sessions/page.tsx`).
    static func matches(_ row: SessionRow, query: String) -> Bool {
        let needle = query.trimmingCharacters(in: .whitespaces).lowercased()
        if needle.isEmpty { return true }
        return [row.name, row.where.detail, row.who, row.statusLabel, row.note]
            .compactMap { $0 }
            .contains { $0.lowercased().contains(needle) }
    }

    static func count(_ rows: [SessionRow]) -> SessionCounts {
        var c = SessionCounts()
        for r in rows {
            if r.status == .needsYou { c.needsYou += 1 }
            if r.status == .running || r.status == .queued { c.running += 1 }
            if r.status == .waiting, r.source != .persistentAgent { c.waiting += 1 }
            if r.recurring, r.status != .paused { c.recurring += 1 }
            if r.source == .persistentAgent, r.status != .done { c.agents += 1 }
        }
        return c
    }

    // MARK: Labels

    static func shortRepo(_ url: String?) -> String? {
        guard let url, !url.isEmpty else { return nil }
        var s = url
        if let range = s.range(of: #"^https?://[^/]+/"#, options: .regularExpression) { s.removeSubrange(range) }
        if s.hasSuffix(".git") { s.removeLast(4) }
        return s
    }

    static func shortDir(_ dir: String?) -> String? {
        guard let dir, !dir.isEmpty else { return nil }
        if let range = dir.range(of: #"^/Users/[^/]+|^/home/[^/]+"#, options: .regularExpression) {
            return "~" + dir[range.upperBound...]
        }
        return dir
    }

    /// `RUNTIMES` in `session-form/model.ts`.
    static let runtimes: [(id: String, label: String)] = [
        ("claude-code", "Claude Code"),
        ("codex", "OpenAI Codex"),
        ("copilot", "GitHub Copilot"),
        ("gemini", "Google Gemini"),
        ("cursor", "Cursor"),
        ("opencode", "OpenCode"),
        ("openclaw", "OpenClaw"),
    ]

    static func runtimeLabel(_ runtime: String) -> String {
        if runtime == "terminal" { return "terminal" }
        return runtimes.first { $0.id == runtime }?.label ?? runtime
    }

    // MARK: Status maps

    static func taskStatus(_ state: String?) -> (SessionStatus, String) {
        let state = state ?? ""
        switch state {
        case "needs_attention": return (.needsYou, "needs attention")
        case "running", "provisioning": return (.running, state)
        case "pr_opened": return (.waiting, "PR open")
        case "queued", "pending", "waiting_on_deps": return (.queued, state.replacingOccurrences(of: "_", with: " "))
        case "completed": return (.done, "completed")
        case "failed": return (.failed, "failed")
        case "cancelled": return (.done, "cancelled")
        default: return (.done, state)
        }
    }

    static func terminalStatus(_ t: TerminalRow) -> (SessionStatus, String) {
        if t.state == "error" { return (.failed, "error") }
        if t.state == "exited" { return (.done, "exited") }
        if t.state == "pending" { return (.queued, t.pendingReason == "host_offline" ? "host offline" : "pending") }
        if t.attentionState == "needs_you" { return (.needsYou, "needs you") }
        if t.attentionState == "idle" { return (.waiting, "idle") }
        return (.running, "working")
    }

    static func agentStatus(_ a: AgentRow) -> (SessionStatus, String) {
        switch a.state {
        case "running", "provisioning": return (.running, a.state ?? "")
        case "queued": return (.queued, "queued")
        case "idle": return (.waiting, "idle")
        case "paused": return (.paused, "paused")
        case "failed": return (.failed, "failed")
        case "archived": return (.done, "archived")
        default: return (.waiting, a.state ?? "idle")
        }
    }

    // MARK: Merge

    static func collect(_ src: Sources) -> [SessionRow] {
        var hostName: [String: String] = [:]
        for h in src.hosts { if let id = h.id, let name = h.name { hostName[id] = name } }
        func machine(_ hostId: String?, _ dir: String?) -> SessionWhere {
            let parts = [hostName[hostId ?? ""], shortDir(dir)].compactMap { $0 }
            return SessionWhere(target: .machine, detail: parts.isEmpty ? nil : parts.joined(separator: " · "))
        }

        var rows: [SessionRow] = []

        for t in src.unified {
            let id = t.id ?? ""
            let local = t.runTarget == "local"
            let last = t.updatedAt ?? t.createdAt
            switch t.type {
            case "repo-task":
                let (status, statusLabel) = taskStatus(t.state)
                let spawned = !(t.metadata?.taskConfigId ?? "").isEmpty
                rows.append(SessionRow(
                    key: "task-\(id)", source: .repoTask, sourceId: id, href: "/tasks/\(id)",
                    name: t.title ?? "",
                    when: spawned ? "on a trigger" : "now",
                    where: local ? machine(t.localHostId, t.localDir) : SessionWhere(target: .pod, detail: shortRepo(t.repoUrl)),
                    who: t.agentType ?? "claude-code",
                    then: .exits,
                    status: status, statusLabel: statusLabel,
                    note: t.prUrl.flatMap { $0.split(separator: "/").last }.map { "PR \($0)" },
                    prUrl: t.prUrl,
                    lastActivity: last,
                    recurring: false, spawned: spawned
                ))
            case "repo-blueprint":
                let paused = t.enabled == false
                rows.append(SessionRow(
                    key: "blueprint-\(id)", source: .repoBlueprint, sourceId: id, href: "/tasks/scheduled/\(id)",
                    name: t.name ?? t.title ?? "",
                    when: "on a trigger",
                    where: local ? machine(t.localHostId, t.localDir) : SessionWhere(target: .pod, detail: shortRepo(t.repoUrl)),
                    who: t.agentType ?? "claude-code",
                    then: .exits,
                    status: paused ? .paused : .scheduled, statusLabel: paused ? "paused" : "armed",
                    note: "opens a PR each run",
                    prUrl: nil,
                    lastActivity: last,
                    recurring: true, spawned: false
                ))
            case "standalone":
                let paused = t.enabled == false
                rows.append(SessionRow(
                    key: "job-\(id)", source: .standalone, sourceId: id, href: "/jobs/\(id)",
                    name: t.name ?? "",
                    when: "on a trigger",
                    where: local ? machine(t.localHostId, t.localDir) : SessionWhere(target: .pod, detail: nil),
                    who: t.agentRuntime ?? "claude-code",
                    then: .exits,
                    status: paused ? .paused : .scheduled, statusLabel: paused ? "paused" : "armed",
                    note: nil,
                    prUrl: nil,
                    lastActivity: last,
                    recurring: true, spawned: false
                ))
            default:
                continue
            }
        }

        for t in src.localTerminals {
            // A local Task run already has its `tasks` row above; a local Job run
            // (workflow_runs) and hand-opened terminals only exist here.
            if let taskId = t.taskId, !taskId.isEmpty { continue }
            let id = t.id ?? ""
            let (status, statusLabel) = terminalStatus(t)
            let isAgent = t.spec?.kind == "agent"
            let agent = isAgent ? (t.spec?.agent ?? "terminal") : "terminal"
            let interactive = !isAgent || t.spec?.mode != "headless"
            let spawnedBy = t.spawnedBy ?? ""
            rows.append(SessionRow(
                key: "terminal-\(id)", source: .localTerminal, sourceId: id, href: "/local/\(id)",
                name: t.title ?? "Terminal",
                when: spawnedBy == "manual" || spawnedBy.isEmpty ? "now" : spawnedBy,
                where: machine(t.hostId, t.dir),
                who: agent,
                then: interactive ? .waitsForMe : .exits,
                status: status, statusLabel: statusLabel,
                note: t.attentionState == "needs_you" ? t.attentionReason : nil,
                prUrl: nil,
                lastActivity: t.lastActivityAt ?? t.updatedAt,
                recurring: false,
                spawned: !(t.blueprintId ?? "").isEmpty || !(t.workflowRunId ?? "").isEmpty
            ))
        }

        for b in src.localBlueprints {
            let id = b.id ?? ""
            let paused = b.enabled == false
            rows.append(SessionRow(
                key: "automation-\(id)", source: .localBlueprint, sourceId: id, href: "/local",
                name: b.name ?? "",
                when: "on an event",
                where: machine(b.hostId, b.dir),
                who: b.agent ?? "terminal",
                then: b.sessionMode == "headless" ? .exits : .waitsForMe,
                status: paused ? .paused : .scheduled, statusLabel: paused ? "paused" : "armed",
                note: nil,
                prUrl: nil,
                lastActivity: b.updatedAt ?? b.createdAt,
                recurring: true, spawned: false
            ))
        }

        for s in src.podSessions {
            let id = s.id ?? ""
            let active = s.state == "active"
            rows.append(SessionRow(
                key: "session-\(id)", source: .podSession, sourceId: id, href: "/sessions/\(id)",
                name: s.branch ?? "Session \(id.prefix(8))",
                when: "now",
                where: SessionWhere(target: .pod, detail: shortRepo(s.repoUrl)),
                who: "terminal",
                then: .waitsForMe,
                status: active ? .waiting : .done, statusLabel: active ? "open" : "ended",
                note: nil,
                prUrl: nil,
                lastActivity: s.lastActivityAt ?? s.endedAt ?? s.createdAt,
                recurring: false, spawned: false
            ))
        }

        for a in src.agents {
            let id = a.id ?? ""
            let (status, statusLabel) = agentStatus(a)
            rows.append(SessionRow(
                key: "agent-\(id)", source: .persistentAgent, sourceId: id, href: "/agents/\(id)",
                name: a.name ?? a.slug ?? "",
                when: "messages",
                where: SessionWhere(target: .pod, detail: a.slug.map { "@\($0)" }),
                who: a.agentRuntime ?? "claude-code",
                then: .waitsForMessages,
                status: status, statusLabel: statusLabel,
                note: nil,
                prUrl: nil,
                lastActivity: a.lastTurnAt ?? a.updatedAt ?? a.createdAt,
                recurring: false, spawned: false
            ))
        }

        return sort(rows)
    }
}
