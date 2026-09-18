import Foundation
import SwiftUI

// MARK: - Response envelopes and route-local rows

/// Trigger attached to a local blueprint (`LocalTriggerSchema` in routes/local.ts).
/// Declared here because the route's row carries `targetType`/`targetId` and a
/// `type` that includes `ticket`, which the generated `WorkflowTrigger` lacks.
struct LocalTrigger: Decodable, Hashable, Identifiable {
    let id: String
    let targetType: String?
    let targetId: String?
    let type: String
    let config: [String: AnyCodable]?
    let paramMapping: [String: AnyCodable]?
    let enabled: Bool
    let lastFiredAt: Date?
    let nextFireAt: Date?
    let createdAt: Date?
    let updatedAt: Date?

    /// Mirrors `triggerSummary()` in blueprints-section.tsx.
    var summary: String {
        let cfg = config ?? [:]
        switch type {
        case "schedule":
            return cfg["cronExpression"]?.stringValue ?? ""
        case "webhook":
            return "/api/hooks/\(cfg["path"]?.stringValue ?? "")"
        case "ticket":
            let source = cfg["source"]?.stringValue ?? "any source"
            let labels = cfg["labels"]?.arrayValue?.compactMap(\.stringValue) ?? []
            return labels.isEmpty ? source : "\(source) · \(labels.joined(separator: ", "))"
        default:
            return ""
        }
    }

    var systemImage: String {
        switch type {
        case "schedule": return "clock"
        case "webhook": return "antenna.radiowaves.left.and.right"
        case "ticket": return "ticket"
        default: return "play"
        }
    }
}

// MARK: - Request bodies

struct CreateLocalTerminalBody: Encodable {
    var hostId: String
    var dir: String
    var title: String?
    var spec: LocalTerminalSpec
}

struct KillLocalTerminalBody: Encodable {
    var signal: String?
}

struct LocalTerminalInputBody: Encodable {
    var data: String
}

/// Shared by create (POST) and update (PATCH). Nil fields are omitted, matching
/// `blueprintBodySchema` (which has no nullable fields besides `agent`).
struct LocalBlueprintBody: Encodable {
    var name: String?
    var description: String?
    var hostId: String?
    var dir: String?
    var repoUrl: String?
    var commandTemplate: String?
    var agent: LocalAgentKind?
    /// Distinguishes "leave agent alone" (nil) from "explicitly shell" (true → null).
    var clearAgent = false
    var spawnMode: LocalBlueprintSpawnMode?
    var enabled: Bool?

    private enum CodingKeys: String, CodingKey {
        case name, description, hostId, dir, repoUrl, commandTemplate, agent, spawnMode, enabled
    }

    func encode(to encoder: any Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encodeIfPresent(name, forKey: .name)
        try c.encodeIfPresent(description, forKey: .description)
        try c.encodeIfPresent(hostId, forKey: .hostId)
        try c.encodeIfPresent(dir, forKey: .dir)
        try c.encodeIfPresent(repoUrl, forKey: .repoUrl)
        try c.encodeIfPresent(commandTemplate, forKey: .commandTemplate)
        if let agent {
            try c.encode(agent, forKey: .agent)
        } else if clearAgent {
            try c.encodeNil(forKey: .agent)
        }
        try c.encodeIfPresent(spawnMode, forKey: .spawnMode)
        try c.encodeIfPresent(enabled, forKey: .enabled)
    }
}

struct SpawnLocalBlueprintBody: Encodable {
    var params: [String: String] = [:]
}

struct CreateLocalTriggerBody: Encodable {
    var type: String
    var config: [String: AnyCodable]
    var enabled: Bool? = nil
}

// MARK: - Endpoints (mirror apps/web/src/lib/api-client.ts "Optio Local" block)

extension APIClient {
    private struct HostsEnvelope: Decodable { let hosts: [LocalHost] }
    private struct TerminalsEnvelope: Decodable { let terminals: [LocalTerminal] }
    private struct TerminalEnvelope: Decodable { let terminal: LocalTerminal }
    private struct BlueprintsEnvelope: Decodable { let blueprints: [LocalBlueprint] }
    private struct BlueprintEnvelope: Decodable { let blueprint: LocalBlueprint }
    private struct TriggersEnvelope: Decodable { let triggers: [LocalTrigger] }
    private struct TriggerEnvelope: Decodable { let trigger: LocalTrigger }

    func listLocalHosts() async throws -> [LocalHost] {
        try await get("/api/local/hosts", as: HostsEnvelope.self).hosts
    }

    func deleteLocalHost(_ id: String) async throws {
        try await delete("/api/local/hosts/\(id)")
    }

    func listLocalTerminals(hostId: String? = nil, state: String? = nil) async throws -> [LocalTerminal] {
        try await get("/api/local/terminals", query: ["hostId": hostId, "state": state], as: TerminalsEnvelope.self).terminals
    }

    func getLocalTerminal(_ id: String) async throws -> LocalTerminal {
        try await get("/api/local/terminals/\(id)", as: TerminalEnvelope.self).terminal
    }

    func createLocalTerminal(_ body: CreateLocalTerminalBody) async throws -> LocalTerminal {
        try await post("/api/local/terminals", body: body, as: TerminalEnvelope.self).terminal
    }

    func startLocalTerminal(_ id: String) async throws -> LocalTerminal {
        try await post("/api/local/terminals/\(id)/start", as: TerminalEnvelope.self).terminal
    }

    func killLocalTerminal(_ id: String, signal: String? = nil) async throws {
        try await post("/api/local/terminals/\(id)/kill", body: KillLocalTerminalBody(signal: signal))
    }

    /// REST fallback for stdin; the stream WS is the primary path.
    func sendLocalTerminalInput(_ id: String, data: String) async throws {
        try await post("/api/local/terminals/\(id)/input", body: LocalTerminalInputBody(data: data))
    }

    func deleteLocalTerminal(_ id: String) async throws {
        try await delete("/api/local/terminals/\(id)")
    }

    func listLocalBlueprints() async throws -> [LocalBlueprint] {
        try await get("/api/local/blueprints", as: BlueprintsEnvelope.self).blueprints
    }

    func getLocalBlueprint(_ id: String) async throws -> LocalBlueprint {
        try await get("/api/local/blueprints/\(id)", as: BlueprintEnvelope.self).blueprint
    }

    func createLocalBlueprint(_ body: LocalBlueprintBody) async throws -> LocalBlueprint {
        try await post("/api/local/blueprints", body: body, as: BlueprintEnvelope.self).blueprint
    }

    func updateLocalBlueprint(_ id: String, _ body: LocalBlueprintBody) async throws -> LocalBlueprint {
        try await patch("/api/local/blueprints/\(id)", body: body, as: BlueprintEnvelope.self).blueprint
    }

    func deleteLocalBlueprint(_ id: String) async throws {
        try await delete("/api/local/blueprints/\(id)")
    }

    func spawnLocalBlueprint(_ id: String, params: [String: String] = [:]) async throws -> LocalTerminal {
        try await post("/api/local/blueprints/\(id)/spawn", body: SpawnLocalBlueprintBody(params: params), as: TerminalEnvelope.self).terminal
    }

    func listLocalBlueprintTriggers(_ id: String) async throws -> [LocalTrigger] {
        try await get("/api/local/blueprints/\(id)/triggers", as: TriggersEnvelope.self).triggers
    }

    func createLocalBlueprintTrigger(_ id: String, _ body: CreateLocalTriggerBody) async throws -> LocalTrigger {
        try await post("/api/local/blueprints/\(id)/triggers", body: body, as: TriggerEnvelope.self).trigger
    }

    func deleteLocalBlueprintTrigger(_ id: String, triggerId: String) async throws {
        try await delete("/api/local/blueprints/\(id)/triggers/\(triggerId)")
    }
}

// MARK: - Presentation helpers (mirror terminal-card.tsx / work-links.tsx)

enum LocalPresentation {
    static let activeStates: Set<LocalTerminalState> = [.pending, .launching, .running]

    /// Last two path segments of an absolute dir — enough to recognize a checkout.
    static func dirTail(_ dir: String) -> String {
        let parts = dir.split(separator: "/").filter { !$0.isEmpty }
        let tail = parts.suffix(2).joined(separator: "/")
        return tail.isEmpty ? dir : tail
    }

    static func attentionLabel(_ reason: String?) -> String {
        switch reason {
        case "stop": return "waiting for you"
        case "notification": return "wants your attention"
        case "bell": return "rang the bell"
        case "quiet": return "gone quiet — probably waiting on you"
        case "exit": return "finished — review the result"
        default: return "needs you"
        }
    }

    static func stateLabel(_ t: LocalTerminal) -> String {
        if t.state == .pending, t.pendingReason == .hostOffline { return "Host offline" }
        if t.state == .pending, t.pendingReason == .hold { return "Held" }
        switch t.state {
        case .pending: return "Pending"
        case .launching: return "Launching"
        case .running: return "Running"
        case .exited: return "Exited"
        case .error: return "Error"
        case .unknown: return "Unknown"
        }
    }

    /// A live terminal that is waiting on the human: the daemon's `needs_you`, or a
    /// running terminal that has gone `idle` (an agent at its prompt in a plain shell,
    /// which the daemon cannot tell from a quiet command).
    static func waitsOnYou(_ t: LocalTerminal) -> Bool {
        guard !isDead(t) else { return false }
        if t.attentionState == .needsYou { return true }
        return t.state == .running && t.attentionState == .idle
    }

    /// Trailing label for a terminal that waits on you.
    static func waitingLabel(_ t: LocalTerminal) -> String {
        t.attentionState == .needsYou ? attentionLabel(t.attentionReason) : "waiting for input"
    }

    /// Terminal state → tone. Needs-you wins over everything while the process is alive.
    static func stateTone(_ t: LocalTerminal) -> Tone {
        if waitsOnYou(t) { return .accent }
        switch t.state {
        case .pending: return .idle
        case .launching, .running: return .working
        case .exited: return t.exitCode.map { $0 == 0 } ?? true ? .idle : .danger
        case .error: return .danger
        case .unknown: return .idle
        }
    }

    static func attentionTone(_ a: LocalAttentionState) -> Tone {
        switch a {
        case .needsYou: return .accent
        case .working: return .working
        case .idle, .unknown: return .idle
        }
    }

    /// Row dot: yellow while it waits on you, red on error, purple while working, none once finished.
    static func rowTone(_ t: LocalTerminal) -> Tone? {
        if waitsOnYou(t) { return .accent }
        if t.state == .error { return .danger }
        if t.state == .exited { return (t.exitCode ?? 0) == 0 ? nil : .danger }
        if t.state == .pending || t.state == .launching { return .idle }
        if t.attentionState == .working { return .working }
        return .idle
    }

    /// Ticket link merged in ahead of scanned links (`collectWorkLinks`).
    static func workLinks(_ t: LocalTerminal) -> [WorkLink] {
        let scanned = t.links
        guard let ticketUrl = t.ticketUrl, !scanned.contains(where: { $0.url == ticketUrl }) else { return scanned }
        let provider: WorkLinkProvider = t.ticketSource == "gitlab" ? .gitlab : .github
        let label = t.ticketExternalId.map { "#\($0)" } ?? "ticket"
        return [WorkLink(url: ticketUrl, kind: .issue, provider: provider, label: label)] + scanned
    }

    static func canStart(_ t: LocalTerminal) -> Bool { t.state == .pending && t.pendingReason != .hostOffline }
    static func canKill(_ t: LocalTerminal) -> Bool { t.state == .running || t.state == .launching }
    static func canDelete(_ t: LocalTerminal) -> Bool { t.state == .exited || t.state == .error || t.state == .pending }
    static func isDead(_ t: LocalTerminal) -> Bool { t.state == .exited || t.state == .error }

    static func spawnSourceIcon(_ s: LocalSpawnSource) -> String {
        switch s {
        case .manual: return "person"
        case .ticket: return "ticket"
        case .trigger: return "antenna.radiowaves.left.and.right"
        case .blueprint: return "square.stack.3d.up"
        case .api: return "cpu"
        case .unknown: return "questionmark"
        }
    }

    static func agentLabel(_ a: LocalAgentKind) -> String {
        switch a {
        case .claudeCode: return "Claude Code"
        case .codex: return "Codex"
        case .cursor: return "Cursor"
        case .gemini: return "Gemini"
        case .opencode: return "OpenCode"
        case .unknown: return a.rawValue
        }
    }

    /// Relative time from the row's activity timestamp (falls back to updatedAt).
    static func activityDescription(_ t: LocalTerminal) -> String {
        (t.lastActivityAt ?? t.updatedAt).relativeDescription
    }
}

/// Small chips for PR / ticket links (`WorkLinkBadges`). Taps open the URL.
struct WorkLinkBadges: View {
    let links: [WorkLink]
    var max: Int = 3

    /// `owner/repo#519` → `PR #519`; `group/proj!45` → `MR !45`; ticket refs (`ENG-12`) as-is.
    /// The repo is implied by the terminal's directory, so the pill only carries the number.
    static func shortLabel(_ link: WorkLink) -> String {
        let label = link.label
        guard let i = label.lastIndex(where: { $0 == "#" || $0 == "!" }) else { return label }
        let number = String(label[i...])
        switch link.kind {
        case .pr: return (number.hasPrefix("!") ? "MR " : "PR ") + number
        default: return number
        }
    }

    var body: some View {
        if !links.isEmpty {
            HStack(spacing: 4) {
                ForEach(links.prefix(max), id: \.url) { link in
                    if let url = URL(string: link.url) {
                        Link(destination: url) {
                            // Explicit HStack: `Label` collapses to icon-only inside a List row's Link.
                            HStack(spacing: 3) {
                                Image(systemName: link.kind == .pr ? "arrow.triangle.pull" : link.kind == .ref ? "number" : "circle.circle")
                                Text(Self.shortLabel(link))
                            }
                                .font(.caption2.monospaced())
                                .lineLimit(1)
                                .fixedSize()
                                .padding(.horizontal, 6)
                                .padding(.vertical, 2)
                                .background(.fill.tertiary, in: Radius.smallShape)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                if links.count > max {
                    Text("+\(links.count - max)").font(.caption2.monospaced()).foregroundStyle(.tertiary)
                }
            }
        }
    }
}
