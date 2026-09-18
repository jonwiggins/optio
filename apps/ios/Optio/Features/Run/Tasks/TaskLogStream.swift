import Foundation
import Observation

/// Historical logs via REST, then live frames over `/ws/logs/:taskId`.
/// Mirrors apps/web/src/hooks/use-logs.ts: catch-up replay frames are ignored
/// (REST history is canonical) and live frames are buffered until history lands.
@Observable @MainActor
final class TaskLogStream {
    let taskId: String
    private(set) var entries: [AgentLogEntry] = []
    private(set) var connected = false
    var onStateChanged: (() -> Void)?

    private var ws: WebSocketClient?
    private var pumpTask: Task<Void, Never>?
    private var pending: [AgentLogEntry] = []
    private var merged = false

    init(taskId: String) { self.taskId = taskId }

    func start(api: APIClient) {
        guard ws == nil else { return }
        let client = WebSocketClient(api: api, path: "/ws/logs/\(taskId)")
        ws = client
        client.connect()
        pumpTask = Task { [weak self] in
            for await frame in client.frames {
                guard let self else { return }
                switch frame {
                case .opened: self.connected = true
                case .closed: self.connected = false
                case .json(let obj): self.handle(obj, api: api)
                default: break
                }
            }
        }
        Task {
            do {
                let rows = try await api.taskLogs(taskId)
                let historical = rows.map { $0.asEntry(taskId: taskId) }
                let keys = Set(historical.map { $0.timestamp + $0.content })
                let live = pending.filter { !keys.contains($0.timestamp + $0.content) }
                entries = historical + live
            } catch {
                entries = pending
            }
            pending = []
            merged = true
        }
    }

    private func handle(_ obj: [String: Any], api: APIClient) {
        guard let type = obj["type"] as? String else { return }
        switch type {
        case "task:log":
            guard let data = try? JSONSerialization.data(withJSONObject: obj),
                  let frame = try? api.decoder.decode(TaskLogFrame.self, from: data),
                  frame.catchUp != true, let content = frame.content else { return }
            let entry = AgentLogEntry(
                taskId: taskId,
                timestamp: frame.timestamp ?? "",
                type: AgentLogEntry.TypeValue(rawValue: frame.logType ?? "text") ?? .text,
                content: content,
                metadata: frame.metadata
            )
            if !merged { pending.append(entry); return }
            if let last = entries.last, last.content == entry.content, last.type == entry.type, last.timestamp == entry.timestamp { return }
            entries.append(entry)
        case "task:state_changed", "task:stalled", "task:recovered", "task:message_delivered", "task:message_acked":
            onStateChanged?()
        default:
            break
        }
    }

    func appendLocal(_ text: String, interrupt: Bool) {
        entries.append(AgentLogEntry(taskId: taskId, timestamp: ISO8601DateFormatter().string(from: .now), type: .info, content: (interrupt ? "[interrupt] " : "[you] ") + text))
    }

    func stop() {
        pumpTask?.cancel()
        pumpTask = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }
}
