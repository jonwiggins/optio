import Foundation
import SwiftUI

/// Async questions use a user-message envelope. Blocking request_user_input
/// is a separate app-server RPC and must still be answered in the terminal.
enum CodexQuestions {
    struct Question: Identifiable {
        let id: String
        let title: String
        let options: [String]
    }
    private static let open = "<send_user_message_question_reply>"
    private static let close = "</send_user_message_question_reply>"

    static func pending(_ entries: [LocalTranscriptEntry]) -> [Question] {
        var questions: [Question] = []
        var seen = Set<String>()
        var answered = Set<String>()
        for entry in entries {
            if entry.role == .system, entry.source == .rewind {
                questions = []; seen = []; answered = []
            }
            if entry.kind == .toolUse, entry.toolName == "request_user_input_async",
               let call = entry.toolUseId, !call.isEmpty, let detail = entry.detail,
               let data = detail.data(using: .utf8),
               let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let values = body["questions"] as? [[String: Any]], !values.isEmpty {
                var parsed: [Question] = []
                for (index, value) in values.enumerated() {
                    guard let title = value["title"] as? String, !title.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { break }
                    let options = value["options"] as? [String] ?? []
                    if let raw = value["options"], !(raw is NSNull), !(raw is [String]) { break }
                    if options.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }) { break }
                    guard let id = json(["request_user_input_async", call, index]) else { break }
                    parsed.append(Question(id: id, title: title, options: options))
                }
                if parsed.count == values.count {
                    for q in parsed where seen.insert(q.id).inserted { questions.append(q) }
                }
            }
            if entry.role == .user, let replies = replies(entry.text) {
                for reply in replies where questions.contains(where: { $0.id == reply.questionItemId && $0.title == reply.question }) {
                    answered.insert(reply.questionItemId)
                }
            }
        }
        return questions.filter { !answered.contains($0.id) }
    }

    struct Reply: Decodable {
        let answer: String
        let question: String
        let questionItemId: String
    }
    static func replies(_ text: String) -> [Reply]? {
        let text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard text.hasPrefix(open), text.hasSuffix(close), text.count >= open.count + close.count,
              let data = String(text.dropFirst(open.count).dropLast(close.count)).data(using: .utf8),
              let replies = try? JSONDecoder().decode([Reply].self, from: data), !replies.isEmpty else { return nil }
        return replies
    }
    static func displayText(_ text: String) -> String {
        replies(text)?.map { "\($0.question)\n\($0.answer)" }.joined(separator: "\n\n") ?? text
    }
    static func replyText(_ question: Question, answer: String) -> String {
        let body = json([["answer": answer, "question": question.title, "questionItemId": question.id]])!
        return open + body.replacingOccurrences(of: "<", with: "\\u003c") + close
    }
    private static func json(_ value: Any) -> String? {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.withoutEscapingSlashes]) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}

struct CodexQuestionCards: View {
    let entries: [LocalTranscriptEntry]
    let terminalId: String
    var body: some View {
        let questions = CodexQuestions.pending(entries)
        if !questions.isEmpty {
            ScrollView {
                VStack(spacing: 10) {
                    ForEach(questions) { question in
                        CodexQuestionCard(question: question, terminalId: terminalId)
                    }
                }.padding(.horizontal).padding(.vertical, 6)
            }.frame(maxHeight: 220)
        }
    }
}

private struct CodexQuestionCard: View {
    @Environment(APIClient.self) private var api
    let question: CodexQuestions.Question
    let terminalId: String
    @State private var other = false
    @State private var answer = ""
    @State private var sending = false
    @State private var sent: String?
    @State private var error: String?
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label("Question from Codex", systemImage: "questionmark.bubble").font(.caption).foregroundStyle(.tint)
            Text(question.title).font(.subheadline)
            if let sent {
                Text("Answer sent: \(sent)").font(.caption).foregroundStyle(.secondary)
            } else {
                ForEach(Array(question.options.enumerated()), id: \.offset) { _, option in
                    Button { send(option) } label: { Text(option).frame(maxWidth: .infinity, alignment: .leading) }
                        .buttonStyle(.bordered)
                }
                if !question.options.isEmpty {
                    Button("Other…") { other.toggle() }
                }
                if other || question.options.isEmpty {
                    TextField("Your answer", text: $answer, axis: .vertical).textFieldStyle(.roundedBorder)
                    Button("Send answer") { send(answer) }.disabled(answer.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if sending { ProgressView("Sending answer…").font(.caption) }
                if let error { Text(error).font(.caption).foregroundStyle(.red) }
            }
        }
        .disabled(sending)
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.tint.opacity(0.06), in: RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(.tint.opacity(0.2)))
    }
    private func send(_ value: String) {
        guard !sending, sent == nil, !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        sending = true; error = nil
        Task {
            defer { sending = false }
            do {
                try await api.sendLocalTerminalInput(terminalId, data: CodexQuestions.replyText(question, answer: value) + "\r")
                sent = value
            } catch { self.error = error.localizedDescription }
        }
    }
}
