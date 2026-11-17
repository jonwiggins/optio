import Foundation
import Observation

/// Chat side of an interactive session, with authoritative replay on every socket connection.
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

    enum ConnectionStatus: String {
        case connecting, ready, thinking, executing, idle, error, disconnected
        case waitingForApproval = "waiting_for_approval"
    }

    let sessionId: String
    private let api: APIClient

    var rows: [Row] = []
    var status: ConnectionStatus = .connecting
    var model: String?
    var costUsd: Double = 0
    var error: String?
    var historyLoaded = false
    private(set) var deliveries: [String: String] = [:]
    private(set) var sendRevision = 0
    private(set) var isInterrupting = false

    private var ws: WebSocketClient?
    private var streamTask: Task<Void, Never>?
    private var replayRows: [Row] = []
    private var streamsText = false

    init(sessionId: String, api: APIClient) {
        self.sessionId = sessionId
        self.api = api
    }

    var isThinking: Bool { status == .thinking || status == .executing }
    var canSend: Bool { historyLoaded && (status == .ready || status == .idle || status == .error) }
    var activityTitle: String {
        if isInterrupting { return "Stopping…" }
        if !historyLoaded, status != .disconnected { return "Syncing conversation…" }
        switch status {
        case .thinking: return "Thinking…"
        case .executing: return "Working…"
        case .waitingForApproval: return "Waiting for approval · open this session on the web"
        case .ready, .idle: return "Ready for your next message"
        case .connecting: return "Connecting…"
        case .disconnected: return "Disconnected · reconnecting…"
        case .error: return "Couldn't complete the request"
        }
    }

    var logEntries: [AgentLogEntry] {
        rows.map { row in
            switch row {
            case .user(let id, let text):
                var metadata: [String: AnyCodable] = ["role": .string("user")]
                if let delivery = deliveries[id] { metadata["delivery"] = .string(delivery) }
                return AgentLogEntry(taskId: sessionId, timestamp: "", type: .text, content: text, metadata: metadata)
            case .entry(_, let entry): return entry
            }
        }
    }

    func start() async {
        guard ws == nil else { return }
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
        isInterrupting = false
    }

    func handle(_ frame: WebSocketClient.Frame) {
        switch frame {
        case .opened:
            status = .connecting
            historyLoaded = false
            replayRows = []
        case .closed(_, let reason):
            status = .disconnected
            isInterrupting = false
            markUnconfirmed()
            if let reason, !reason.isEmpty { error = reason }
        case .json(let obj):
            // Harness sessions also use these frames beyond the legacy generated
            // protocol. In particular, "executing" must never decode as ready.
            if obj["type"] as? String == "status" {
                status = ConnectionStatus(rawValue: obj["status"] as? String ?? "") ?? .connecting
                if obj["runtime"] as? String != nil { streamsText = true }
                if let m = obj["model"] as? String { model = m }
                if let c = obj["costUsd"] as? Double { costUsd = c }
                if !isThinking { isInterrupting = false }
                if status != .error { error = nil }
                return
            }
            if obj["type"] as? String == "user_message", let text = obj["content"] as? String {
                receiveUser(text, requestId: obj["requestId"] as? String)
                return
            }
            if obj["type"] as? String == "queue", let messages = obj["messages"] as? [[String: Any]] {
                for message in messages {
                    if let id = message["requestId"] as? String, deliveries[id] != nil { deliveries[id] = "Queued" }
                }
                return
            }
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let msg = try? api.decoder.decode(SessionChatServerMessage.self, from: data) else { return }
            switch msg {
            case .chatEvent(let p):
                let e = p.event
                let eventType = (obj["event"] as? [String: Any])?["type"] as? String
                let savedFrame: [String: AnyCodable]
                if case .object(let frame) = e.metadata?["frame"] { savedFrame = frame } else { savedFrame = [:] }
                let requestId = e.metadata?["requestId"]?.stringValue ?? savedFrame["requestId"]?.stringValue
                let replaying = obj["catchUp"] as? Bool == true
                if eventType == "user_message" {
                    if replaying {
                        replayRows.append(.user(id: requestId ?? UUID().uuidString, text: e.content))
                        if let requestId { deliveries[requestId] = "Sent" }
                    } else {
                        receiveUser(e.content, requestId: requestId)
                    }
                    return
                }
                let entry = AgentLogEntry(
                    taskId: e.taskId, timestamp: e.timestamp, sessionId: e.sessionId,
                    type: AgentLogEntry.TypeValue(rawValue: e.type.rawValue) ?? .text,
                    content: e.content, metadata: e.metadata
                )
                if replaying {
                    Self.append(entry, to: &replayRows, coalesce: savedFrame["type"]?.stringValue == "text")
                    return
                }
                Self.append(entry, to: &rows, coalesce: streamsText)
                if e.type == .error {
                    error = e.content
                    status = .error
                    isInterrupting = false
                    markUnconfirmed()
                }
            case .costUpdate(let p):
                costUsd = p.costUsd
            case .status:
                break // Handled above, including newer server states.
            case .error(let p):
                error = p.message
                status = .error
                isInterrupting = false
                markUnconfirmed()
            case .historyDone:
                let replayIds = Set(replayRows.map(\.id))
                let unsynced = rows.filter { deliveries[$0.id] != nil && deliveries[$0.id] != "Sent" && !replayIds.contains($0.id) }
                rows = replayRows + unsynced
                replayRows = []
                historyLoaded = true
            case .unknown:
                break
            }
        case .text, .binary:
            break
        }
    }

    /// Harness text frames are fragments of one response, not separate messages.
    private static func append(_ entry: AgentLogEntry, to rows: inout [Row], coalesce: Bool) {
        if coalesce, entry.type == .text, case .entry(let id, let previous) = rows.last, previous.type == .text {
            rows[rows.count - 1] = .entry(id: id, AgentLogEntry(
                taskId: previous.taskId, timestamp: previous.timestamp, sessionId: previous.sessionId,
                type: .text, content: previous.content + entry.content, metadata: previous.metadata
            ))
        } else {
            rows.append(.entry(id: UUID().uuidString, entry))
        }
    }

    // MARK: Client → server

    private func receiveUser(_ text: String, requestId: String?) {
        let id = requestId ?? UUID().uuidString
        if !rows.contains(where: { $0.id == id }) { rows.append(.user(id: id, text: text)) }
        deliveries[id] = "Sent"
    }

    private func markUnconfirmed() {
        for (id, delivery) in deliveries where delivery == "Sending…" {
            deliveries[id] = "Delivery unconfirmed · reconnect before sending again"
        }
    }

    /// Keep local identity through the server echo so a send never doubles up.
    func prepareSend(_ text: String) -> [String: Any]? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty else { return nil }
        let id = UUID().uuidString
        rows.append(.user(id: id, text: text))
        deliveries[id] = "Sending…"
        sendRevision += 1
        status = .thinking
        error = nil
        return ["type": "message", "content": text, "requestId": id]
    }

    func send(_ text: String) async {
        guard let ws, let frame = prepareSend(text) else { return }
        do {
            try await ws.send(json: frame)
        } catch {
            self.error = error.localizedDescription
            status = .disconnected
            markUnconfirmed()
        }
    }

    func interrupt() async {
        guard isThinking, !isInterrupting, let ws else { return }
        isInterrupting = true
        do { try await ws.send(SessionChatClientMessage.interrupt) }
        catch { isInterrupting = false; self.error = error.localizedDescription }
    }

    func setModel(_ m: String) async {
        model = m
        try? await ws?.send(SessionChatClientMessage.setModel(.init(model: m)))
    }
}
