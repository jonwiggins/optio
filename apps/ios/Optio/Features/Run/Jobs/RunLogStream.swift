import Foundation
import Observation

/// Historical + live log feed for a job run or PR review. Mirrors
/// `useWorkflowRunLogs` / `usePrReviewLogs` on the web:
///   1. opens the WebSocket (server replays recent rows with `catchUp: true`,
///      which are ignored because REST history is canonical)
///   2. fetches history over REST
///   3. buffers live frames until history has merged, dedupes on timestamp+content
/// State-change frames call `onStateChanged` so the owning screen can refetch.
@Observable @MainActor
final class RunLogStream {
    var entries: [AgentLogEntry] = []
    var connected = false
    var error: Error?

    private let logEventType: String
    private let stateEventTypes: Set<String>
    private var ws: WebSocketClient?
    private var pump: Task<Void, Never>?
    private var pending: [AgentLogEntry] = []
    private var merged = false
    var onStateChanged: (@MainActor () -> Void)?

    init(logEventType: String, stateEventTypes: Set<String>) {
        self.logEventType = logEventType
        self.stateEventTypes = stateEventTypes
    }

    private struct Frame: Decodable {
        let type: String
        let content: String?
        let logType: String?
        let metadata: [String: AnyCodable]?
        let timestamp: Date?
        let catchUp: Bool?
    }

    /// `history` loads REST rows; `wsPath` is opened only when non-nil.
    func start(api: APIClient, wsPath: String?, history: @escaping () async throws -> [RunLogRow]) {
        stop()
        merged = false
        pending = []

        if let wsPath {
            let client = WebSocketClient(api: api, path: wsPath)
            ws = client
            client.connect()
            pump = Task { [weak self] in
                for await frame in client.frames {
                    guard let self else { return }
                    switch frame {
                    case .opened: connected = true
                    case .closed: connected = false
                    case .json(let obj): handle(obj, api: api)
                    default: break
                    }
                }
            }
        }

        Task { [weak self] in
            guard let self else { return }
            do {
                let rows = try await history()
                let historical = rows.map(\.asEntry)
                let keys = Set(historical.map { $0.timestamp + $0.content })
                let live = pending.filter { !keys.contains($0.timestamp + $0.content) }
                entries = historical + live
                error = nil
            } catch {
                self.error = error
                entries = pending
            }
            pending = []
            merged = true
        }
    }

    /// Re-fetch history (e.g. after a re-review spawns a new run) without
    /// dropping the WebSocket.
    func reloadHistory(_ history: @escaping () async throws -> [RunLogRow]) {
        Task { [weak self] in
            guard let self else { return }
            if let rows = try? await history() {
                let historical = rows.map(\.asEntry)
                let keys = Set(historical.map { $0.timestamp + $0.content })
                let extra = entries.filter { !keys.contains($0.timestamp + $0.content) && $0.timestamp > (historical.last?.timestamp ?? "") }
                entries = historical + extra
            }
        }
    }

    private func handle(_ obj: [String: Any], api: APIClient) {
        guard let type = obj["type"] as? String else { return }
        if stateEventTypes.contains(type) {
            onStateChanged?()
            return
        }
        guard type == logEventType,
              let data = try? JSONSerialization.data(withJSONObject: obj),
              let frame = try? api.decoder.decode(Frame.self, from: data),
              let content = frame.content
        else { return }
        if frame.catchUp == true { return }
        let entry = AgentLogEntry(
            taskId: "",
            timestamp: frame.timestamp.map { RunLogRow.iso.string(from: $0) } ?? (obj["timestamp"] as? String ?? ""),
            type: AgentLogEntry.TypeValue(rawValue: frame.logType ?? "text") ?? .unknown,
            content: content,
            metadata: frame.metadata
        )
        if !merged {
            pending.append(entry)
        } else if let last = entries.last, last.content == entry.content, last.type == entry.type, last.timestamp == entry.timestamp {
            return
        } else {
            entries.append(entry)
        }
    }

    func stop() {
        pump?.cancel()
        pump = nil
        ws?.disconnect()
        ws = nil
        connected = false
    }
}
