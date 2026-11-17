import Foundation
import Observation

/// A native view of the saved assistant harness session. The server owns history;
/// drafts stay local and reconnecting never replays an uncertain action.
@Observable @MainActor
final class OptioAssistantModel {
    struct Proposal {
        let id: String
        let items: [String]
        let work: [[String: Any]]
        var decision: String?
    }
    struct Row: Identifiable {
        let id = UUID()
        var role = "assistant"
        var text: String
        var isError = false
        var proposal: Proposal?
        var requestId: String?
    }
    struct QueuedMessage: Identifiable, Equatable {
        let requestId: String
        let content: String
        var id: String { requestId }
    }
    enum Status: String { case disconnected, connecting, ready, thinking, executing, waitingForApproval }
    let conversationID: String?
    init(conversationID: String? = nil) { self.conversationID = conversationID }

    var rows: [Row] = []
    var draft = ""
    var status: Status = .disconnected
    private(set) var hasLoadedHistory = false
    private(set) var connectionError: String?
    private(set) var sessionId: String?
    private(set) var sessionHref: String?
    private var isClearing = false
    private(set) var queue: [QueuedMessage] = []
    private(set) var isSending = false
    private var pendingSend: QueuedMessage?
    private(set) var cancellingRequests: Set<String> = []
    private(set) var runtime: String?
    private(set) var selectedModel: String?
    private var socket: WebSocketClient?
    private var pump: Task<Void, Never>?
    private var streamId: UUID?
    private var generation = UUID()

    var needsApproval: Bool { rows.contains { $0.proposal != nil && $0.proposal?.decision == nil } }
    var signature: String { "\(rows.count):\(rows.last?.text ?? ""):\(rows.last?.proposal?.decision ?? "")" }
    var statusLabel: String {
        if !hasLoadedHistory, status != .disconnected { return "Syncing conversation" }
        if needsApproval { return "Needs your approval" }
        if !queue.isEmpty { return "Working · \(queue.count) queued" }
        return switch status {
        case .ready: "Ready"
        case .waitingForApproval: "Needs your approval"
        case .thinking: "Thinking…"
        case .executing: "Working…"
        case .connecting: "Connecting…"
        case .disconnected: "Offline"
        }
    }
    func socketURL(api: APIClient) -> URL {
        var url = URLComponents(url: api.wsURL("/ws/optio/chat"), resolvingAgainstBaseURL: false)!
        if let conversationID { url.queryItems = [URLQueryItem(name: "sessionId", value: conversationID)] }
        return url.url!
    }

    var canSend: Bool { hasLoadedHistory && status != .disconnected && status != .connecting && !isClearing && !isSending }
    var canReset: Bool { hasLoadedHistory && status == .ready && !isClearing && !isSending && queue.isEmpty && !rows.contains { $0.proposal != nil && $0.proposal?.decision == nil } }
    var identity: String? {
        guard let runtime else { return nil }
        return WorkFeed.runtimeLabel(runtime) + " · " + (selectedModel?.isEmpty == false ? selectedModel! : "Default model")
    }

    func start(api: APIClient) {
        guard socket == nil || status == .disconnected else { return }
        stop()
        hasLoadedHistory = false
        connectionError = nil
        status = .connecting
        let token = api.token
        // Use the selected server and workspace to attach to the saved session.
        let client = WebSocketClient(url: socketURL(api: api), tokenProvider: { token }, autoReconnect: true, headers: api.workspaceId.map { ["x-workspace-id": $0] } ?? [:], maximumMessageSize: 16 * 1024 * 1024)
        socket = client
        let current = generation
        pump = Task { [weak self] in
            for await frame in client.frames {
                guard let self, !Task.isCancelled, self.generation == current else { return }
                self.handle(frame)
            }
        }
        client.connect()
    }

    func stop() {
        generation = UUID()
        pump?.cancel()
        pump = nil
        socket?.disconnect()
        socket = nil
        status = .disconnected
        hasLoadedHistory = false
        isClearing = false
        isSending = false
        cancellingRequests = []
        streamId = nil
    }

    func reconnect(api: APIClient) {
        stop()
        start(api: api)
    }

    /// Internal so tests can drive actual server frames without a model or microphone.
    func handle(_ frame: WebSocketClient.Frame) {
        switch frame {
        case .opened:
            status = .connecting
            hasLoadedHistory = false
            connectionError = nil
        case .closed(_, let reason):
            status = .disconnected
            hasLoadedHistory = false
            isClearing = false
            isSending = false
            cancellingRequests = []
            streamId = nil
            connectionError = reason ?? "Connection lost. Reconnecting to your saved conversation…"
        case .json(let obj):
            switch obj["type"] as? String {
            case "queue":
                guard let messages = obj["messages"] as? [[String: Any]] else { return }
                queue = messages.compactMap { value in
                    guard let id = value["requestId"] as? String, let content = value["content"] as? String else { return nil }
                    return QueuedMessage(requestId: id, content: content)
                }
                cancellingRequests = cancellingRequests.intersection(Set(queue.map(\.requestId)))
                if let pendingSend, queue.contains(where: { $0.requestId == pendingSend.requestId }) { acknowledge(pendingSend.requestId) }
            case "history":
                guard let frames = obj["frames"] as? [[String: Any]] else { return }
                hasLoadedHistory = true
                connectionError = nil
                rows = []
                streamId = nil
                isClearing = false
                sessionId = (obj["sessionId"] as? String).flatMap { UUID(uuidString: $0) == nil ? nil : $0 }
                sessionHref = sessionId.flatMap { id in
                    let href = obj["href"] as? String
                    return href == "/work/\(id)" || href == "/sessions/\(id)" ? href : nil
                }
                for frame in frames {
                    switch frame["type"] as? String {
                    case "user_message":
                        streamId = nil
                        if let content = frame["content"] as? String {
                            if let id = frame["requestId"] as? String { acknowledge(id) }
                            appendUserMessage(content, requestId: frame["requestId"] as? String)
                        }
                    case "text":
                        if let content = frame["content"] as? String { appendText(content) }
                    case "error", "action_result":
                        streamId = nil
                        guard let content = frame["content"] as? String ?? frame["message"] as? String ?? frame["summary"] as? String else { continue }
                        let isError = frame["type"] as? String == "error" || frame["success"] as? Bool == false
                        rows.append(Row(text: content, isError: isError))
                    default: break
                    }
                }
            case "user_message":
                guard let content = obj["content"] as? String else { return }
                streamId = nil
                if let id = obj["requestId"] as? String {
                    queue.removeAll { $0.requestId == id }
                    acknowledge(id)
                }
                appendUserMessage(content, requestId: obj["requestId"] as? String)
            case "status":
                if let runtime = obj["runtime"] as? String { self.runtime = runtime }
                if let model = obj["model"] as? String { selectedModel = model }
                let value = obj["status"] as? String
                status = value == "waiting_for_approval" ? .waitingForApproval : Status(rawValue: value ?? "") ?? .connecting
                if status == .ready { streamId = nil }
            case "text":
                guard let text = obj["content"] as? String else { return }
                appendText(text)
            case "action_proposal":
                guard let id = obj["actionId"] as? String else { return }
                guard !rows.contains(where: { $0.proposal?.id == id }) else { return }
                streamId = nil
                rows.append(Row(text: obj["description"] as? String ?? "Review action", proposal: Proposal(
                    id: id, items: obj["items"] as? [String] ?? [], work: obj["work"] as? [[String: Any]] ?? []
                )))
            case "action_decision":
                guard let id = obj["actionId"] as? String, let approved = obj["approved"] as? Bool else { return }
                settleProposal(id, decision: approved ? "Approved" : "Declined")
            case "action_expired":
                guard let id = obj["actionId"] as? String else { return }
                settleProposal(id, decision: "Expired — request a fresh proposal")
            case "action_result", "error":
                if obj["type"] as? String == "action_result", let id = obj["actionId"] as? String {
                    settleProposal(id, decision: "Approved")
                }
                if obj["type"] as? String == "error" {
                    isClearing = false
                    if let id = obj["requestId"] as? String {
                        cancellingRequests.remove(id)
                        if pendingSend?.requestId == id { pendingSend = nil; isSending = false }
                    }
                }
                streamId = nil
                let isError = obj["type"] as? String == "error" || obj["success"] as? Bool == false
                rows.append(Row(text: obj["summary"] as? String ?? obj["message"] as? String ?? "Optio couldn’t process the request.", isError: isError))
            default: break
            }
        default: break
        }
    }

    private func appendText(_ text: String) {
        if let index = rows.firstIndex(where: { $0.id == streamId }) { rows[index].text += text }
        else {
            let row = Row(text: text)
            streamId = row.id
            rows.append(row)
        }
    }

    /// Saved history and live messages use the same request identity.
    func appendUserMessage(_ content: String, requestId: String?) {
        if let requestId, rows.contains(where: { $0.requestId == requestId }) { return }
        rows.append(Row(role: "user", text: content, requestId: requestId))
    }

    private func settleProposal(_ id: String, decision: String) {
        for index in rows.indices where rows[index].proposal?.id == id {
            rows[index].proposal?.decision = decision
        }
        streamId = nil
    }

    static func json(_ value: Any) -> String {
        if let text = value as? String { return text }
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.prettyPrinted, .sortedKeys, .fragmentsAllowed]) else { return String(describing: value) }
        return String(decoding: data, as: UTF8.self)
    }

    private func acknowledge(_ id: String) {
        guard let pendingSend, pendingSend.requestId == id else { return }
        if draft.trimmingCharacters(in: .whitespacesAndNewlines) == pendingSend.content { draft = "" }
        self.pendingSend = nil
        isSending = false
    }

    /// Start a submission without claiming it is queued or part of the transcript yet.
    func prepareSend() -> [String: Any]? {
        let text = draft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard canSend, !text.isEmpty else { return nil }
        let requestId = UUID().uuidString
        pendingSend = QueuedMessage(requestId: requestId, content: text)
        isSending = true
        return ["type": "message", "content": text, "requestId": requestId]
    }

    func send() async {
        guard let socket, let frame = prepareSend() else { return }
        do {
            // Queue acknowledgement (or a turn's user_message) owns the draft clear.
            // Never add queued requests to the transcript before the turn starts.
            try await socket.send(json: frame)
        } catch {
            stop()
            rows.append(Row(text: "Couldn’t queue the request. Your draft is preserved. Reconnect before trying again.", isError: true))
        }
    }

    func cancelQueued(_ id: String) async {
        guard canSend, queue.contains(where: { $0.requestId == id }), !cancellingRequests.contains(id), let socket else { return }
        cancellingRequests.insert(id)
        do { try await socket.send(json: ["type": "cancel_queued", "requestId": id]) }
        catch {
            cancellingRequests.remove(id)
            stop()
        }
    }

    func decide(id: String, approve: Bool) async {
        guard status == .waitingForApproval, let socket,
              let index = rows.firstIndex(where: { $0.proposal?.id == id && $0.proposal?.decision == nil }) else { return }
        // Disable immediately: a second tap must never execute an action twice.
        rows[index].proposal?.decision = approve ? "Approved" : "Declined"
        status = .executing
        streamId = nil
        do { try await socket.send(json: ["type": approve ? "approve" : "deny", "actionId": id]) }
        catch {
            stop()
            rows.append(Row(text: "Connection lost. Check Work before repeating this action; its result may be uncertain.", isError: true))
        }
    }

    func reset() async {
        guard canReset, let socket else { return }
        isClearing = true
        do {
            // Only the history acknowledgement clears rows; a rejected clear keeps them.
            try await socket.send(json: ["type": "interrupt"])
        } catch { stop() }
    }
}
