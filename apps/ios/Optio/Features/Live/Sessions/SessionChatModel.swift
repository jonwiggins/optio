import Foundation
import Observation

/// Chat side of an interactive session: REST history, then `/ws/sessions/:id/chat`.
/// Mirrors `apps/web/src/components/session-chat.tsx`.
@Observable
@MainActor
final class SessionChatModel {
    enum Row: Hashable {
        case user(id: String, text: String)
        case entry(id: String, AgentLogEntry)
        var id: String {
            switch self {
            case .user(let id, _), .entry(let id, _): return id
            }
        }
    }

    enum ConnectionStatus: String { case connecting, ready, thinking, idle, error, disconnected }

    let sessionId: String
    private let api: APIClient

    var rows: [Row] = []
    var status: ConnectionStatus = .connecting
    var model: String?
    var costUsd: Double = 0
    var error: String?
    var historyLoaded = false

    private var ws: WebSocketClient?
    private var streamTask: Task<Void, Never>?

    init(sessionId: String, api: APIClient) {
        self.sessionId = sessionId
        self.api = api
    }

    var isThinking: Bool { status == .thinking }
    var canSend: Bool { status == .ready || status == .idle }

    func start() async {
        guard ws == nil else { return }
        await loadHistory()
        let client = WebSocketClient(api: api, path: "/ws/sessions/\(sessionId)/chat")
        ws = client
        client.connect()
        streamTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled else { return }
                self.handle(frame)
            }
        }
    }

    func stop() {
        streamTask?.cancel()
        streamTask = nil
        ws?.disconnect()
        ws = nil
        status = .disconnected
    }

    private func loadHistory() async {
        do {
            let events = try await api.sessionChatHistory(sessionId)
            rows = events.map { ev in
                let id = ev.id ?? UUID().uuidString
                if ev.logType == "user_message" || ev.stream == "stdin" {
                    return .user(id: id, text: ev.content)
                }
                return .entry(id: id, AgentLogEntry(
                    taskId: sessionId,
                    timestamp: ev.timestamp.map { ISO8601DateFormatter().string(from: $0) } ?? "",
                    type: AgentLogEntry.TypeValue(rawValue: ev.logType ?? "text") ?? .text,
                    content: ev.content,
                    metadata: ev.metadata
                ))
            }
            historyLoaded = true
        } catch {
            self.error = error.localizedDescription
        }
    }

    private func handle(_ frame: WebSocketClient.Frame) {
        switch frame {
        case .opened:
            status = .connecting
        case .closed(_, let reason):
            status = .disconnected
            if let reason, !reason.isEmpty { error = reason }
        case .json(let obj):
            // The socket replays persisted history on connect; REST already loaded it.
            if historyLoaded, obj["catchUp"] as? Bool == true { return }
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let msg = try? api.decoder.decode(SessionChatServerMessage.self, from: data) else { return }
            switch msg {
            case .chatEvent(let p):
                let e = p.event
                if e.type == .unknown, obj["event"].flatMap({ ($0 as? [String: Any])?["type"] as? String }) == "user_message" {
                    rows.append(.user(id: UUID().uuidString, text: e.content))
                    return
                }
                rows.append(.entry(id: UUID().uuidString, AgentLogEntry(
                    taskId: e.taskId, timestamp: e.timestamp, sessionId: e.sessionId,
                    type: AgentLogEntry.TypeValue(rawValue: e.type.rawValue) ?? .text,
                    content: e.content, metadata: e.metadata
                )))
            case .costUpdate(let p):
                costUsd = p.costUsd
            case .status(let p):
                status = ConnectionStatus(rawValue: p.status.rawValue) ?? .ready
                if let m = p.model { model = m }
                if let c = p.costUsd { costUsd = c }
                if status != .error { error = nil }
            case .error(let p):
                error = p.message
            case .unknown:
                break
            }
        case .text, .binary:
            break
        }
    }

    // MARK: Client → server

    func send(_ text: String) async {
        rows.append(.user(id: UUID().uuidString, text: text))
        status = .thinking
        do {
            try await ws?.send(SessionChatClientMessage.message(.init(content: text)))
        } catch {
            self.error = error.localizedDescription
        }
    }

    func interrupt() async {
        try? await ws?.send(SessionChatClientMessage.interrupt)
    }

    func setModel(_ m: String) async {
        model = m
        try? await ws?.send(SessionChatClientMessage.setModel(.init(model: m)))
    }
}
