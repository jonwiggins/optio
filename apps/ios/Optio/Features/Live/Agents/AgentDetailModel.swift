import Foundation
import Observation

/// Screen state for one persistent agent: the agent row + inbox summary, recent
/// messages, turns, and a live log tail fed by `/ws/persistent-agents/:id/events`.
/// Mirrors the refresh choreography of `apps/web/src/app/agents/[id]/page.tsx`
/// and `hooks/use-agent-logs.ts`.
@Observable
@MainActor
final class AgentDetailModel {
    let agentId: String
    private let api: APIClient

    var agent: PersistentAgent?
    var inbox = PersistentAgentInbox()
    var messages: [PersistentAgentMessage] = []
    var turns: [PersistentAgentTurn] = []
    var triggers: [PersistentAgentTrigger] = []
    var liveLogs: [AgentLogEntry] = []
    var liveTurnId: String?
    var error: Error?
    var actionError: Error?
    var connected = false
    var deleted = false

    private var ws: WebSocketClient?
    private var streamTask: Task<Void, Never>?

    init(agentId: String, api: APIClient) {
        self.agentId = agentId
        self.api = api
    }

    // MARK: Lifecycle

    func start() async {
        await refreshAll()
        connect()
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }

    // MARK: Loading

    func refreshAll() async {
        await refreshAgent()
        await refreshMessages()
        await refreshTurns()
        await refreshTriggers()
    }

    func refreshAgent() async {
        do {
            let r = try await api.getPersistentAgent(agentId)
            agent = r.agent
            inbox = r.inbox
            error = nil
        } catch {
            self.error = error
        }
    }

    func refreshMessages() async {
        if let m = try? await api.listPersistentAgentMessages(agentId, limit: 50) {
            // API returns newest first; the transcript reads oldest → newest.
            messages = m.reversed()
        }
    }

    func refreshTurns() async {
        if let t = try? await api.listPersistentAgentTurns(agentId, limit: 30) {
            turns = t
        }
    }

    func refreshTriggers() async {
        if let t = try? await api.listPersistentAgentTriggers(agentId) {
            triggers = t
        }
    }

    // MARK: Actions

    func send(_ body: String) async {
        do {
            try await api.sendPersistentAgentMessage(agentId, body: body)
            actionError = nil
            await refreshAgent()
            await refreshMessages()
        } catch {
            actionError = error
        }
    }

    func control(_ intent: PersistentAgentControlIntent) async {
        do {
            try await api.controlPersistentAgent(agentId, intent: intent)
            actionError = nil
            await refreshAgent()
        } catch {
            actionError = error
        }
    }

    func delete() async {
        do {
            try await api.deletePersistentAgent(agentId)
            deleted = true
        } catch {
            actionError = error
        }
    }

    func deleteTrigger(_ triggerId: String) async {
        do {
            try await api.deletePersistentAgentTrigger(agentId, triggerId: triggerId)
            triggers.removeAll { $0.id == triggerId }
        } catch {
            actionError = error
        }
    }

    // MARK: Live events

    private func connect() {
        let client = WebSocketClient(api: api, path: "/ws/persistent-agents/\(agentId)/events")
        ws = client
        client.connect()
        streamTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                await self.handle(frame)
            }
        }
    }

    private func handle(_ frame: WebSocketClient.Frame) async {
        switch frame {
        case .opened:
            connected = true
        case .closed:
            connected = false
        case .json(let obj):
            guard let type = obj["type"] as? String,
                  let data = try? JSONSerialization.data(withJSONObject: obj) else { return }
            switch type {
            case "persistent_agent:log":
                guard let ev = try? api.decoder.decode(PersistentAgentLogEvent.self, from: data) else { return }
                if let liveTurnId, liveTurnId != ev.turnId {
                    // New turn's output: anchor the tail to it.
                    liveLogs.removeAll()
                }
                liveTurnId = ev.turnId
                liveLogs.append(AgentLogEntry(
                    taskId: agentId,
                    timestamp: ev.timestamp,
                    type: AgentLogEntry.TypeValue(rawValue: ev.logType ?? "text") ?? .text,
                    content: ev.content,
                    metadata: ev.metadata
                ))
                if liveLogs.count > 2000 { liveLogs.removeFirst(liveLogs.count - 2000) }
            case "persistent_agent:turn_started":
                liveLogs.removeAll()
                liveTurnId = (obj["turnId"] as? String)
                await refreshAgent()
                await refreshTurns()
            case "persistent_agent:turn_halted":
                await refreshAgent()
                await refreshMessages()
                await refreshTurns()
            case "persistent_agent:state_changed":
                await refreshAgent()
                await refreshTurns()
            case "persistent_agent:message":
                await refreshAgent()
                await refreshMessages()
            default:
                break
            }
        case .text, .binary:
            break
        }
    }
}
