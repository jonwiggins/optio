import Foundation

/// Input reaches the terminal before it reaches the saved transcript. Keep that
/// gap visible, and reconcile only new, ordinary user entries, one for one.
struct LocalChatOutbox {
    enum Delivery: String {
        case sending = "Sending…"
        case sent = "Sent · waiting for the agent"
        case uncertain = "Delivery unconfirmed · check Terminal before sending again"
    }
    struct Message: Identifiable {
        let id = UUID()
        let text: String
        let afterSeq: Double
        let timestamp = ISO8601DateFormatter().string(from: Date())
        var delivery: Delivery = .sending
    }
    private(set) var messages: [Message] = []

    mutating func begin(_ text: String, afterSeq: Double) -> UUID {
        let message = Message(text: text, afterSeq: afterSeq)
        messages.append(message)
        return message.id
    }

    mutating func settle(_ id: UUID, delivery: Delivery) {
        guard let index = messages.firstIndex(where: { $0.id == id }) else { return }
        messages[index].delivery = delivery
    }

    /// Only pass newly fetched entries. Reusing a previous page would let one
    /// echo consume two identical submissions on successive polls.
    mutating func reconcile(_ entries: [LocalTranscriptEntry]) {
        for entry in entries where entry.role == .user && entry.kind == .text && entry.source == nil {
            if let index = messages.firstIndex(where: {
                entry.seq > $0.afterSeq && normalize(entry.text) == normalize($0.text)
            }) {
                messages.remove(at: index)
            }
        }
    }

    func logEntries(terminalId: String) -> [AgentLogEntry] {
        messages.map { message in
            AgentLogEntry(taskId: terminalId, timestamp: message.timestamp, type: .text, content: message.text,
                          metadata: ["role": .string("user"), "delivery": .string(message.delivery.rawValue)])
        }
    }

    private func normalize(_ text: String) -> String {
        text.replacingOccurrences(of: "\r\n", with: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
