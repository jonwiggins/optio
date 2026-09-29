import SwiftUI

/// Renders a transcript of `AgentLogEntry` rows the way the web log viewer does:
/// assistant text as prose, tool calls as collapsible monospace blocks, thinking
/// dimmed, errors red. Used for task logs, job run logs, review logs, session chat
/// and persistent-agent turns alike so every surface reads the same.
struct AgentLogView: View {
    let entries: [AgentLogEntry]
    var autoScroll = true
    /// The reader is at the end: new entries scroll into view. Once they scroll
    /// up to read back, a live log stops pulling them down.
    @State private var atBottom = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { idx, entry in
                        AgentLogRow(entry: entry).id(idx)
                    }
                    // iOS 17 has no scroll geometry: the end coming into view stands in.
                    Color.clear.frame(height: 1)
                        .onAppear { if #unavailable(iOS 18.0) { atBottom = true } }
                        .onDisappear { if #unavailable(iOS 18.0) { atBottom = false } }
                }
                .padding()
            }
            .modifier(TracksBottom(atBottom: $atBottom))
            .onChange(of: entries.count) { old, count in
                // Land at the end when the log first loads; after that, follow
                // only a reader who is already there.
                guard autoScroll, count > 0, old == 0 || atBottom else { return }
                withAnimation { proxy.scrollTo(count - 1, anchor: .bottom) }
            }
        }
    }
}

/// Whether a scroll view is at (or within a few points of) its end.
private struct TracksBottom: ViewModifier {
    @Binding var atBottom: Bool

    func body(content: Content) -> some View {
        if #available(iOS 18.0, *) {
            content.onScrollGeometryChange(for: Bool.self) { geo in
                geo.contentOffset.y + geo.containerSize.height >= geo.contentSize.height - 48
            } action: { _, isAtBottom in
                atBottom = isAtBottom
            }
        } else {
            content
        }
    }
}

struct AgentLogRow: View {
    let entry: AgentLogEntry
    @State private var expanded = false

    var body: some View {
        switch entry.type {
        case .text where isUser || isPrompt:
            userBubble
        case .system where systemSource != nil:
            systemNote
        case .text:
            Text(LocalizedStringKey(entry.content))
                .font(.body)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .thinking:
            Text(entry.content)
                .font(.footnote)
                .italic()
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .toolUse, .toolResult:
            toolBlock
        case .error:
            Label(entry.content, systemImage: "xmark.octagon")
                .font(.monoFootnote)
                .foregroundStyle(Tone.danger.textStyle)
                .frame(maxWidth: .infinity, alignment: .leading)
        case .system, .info, .unknown:
            Text(entry.content)
                .font(.caption.monospaced())
                .foregroundStyle(.secondary)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var toolName: String {
        entry.metadata?["toolName"]?.stringValue ?? (entry.type == .toolUse ? "tool" : "result")
    }

    // Optional metadata a producer may attach (see `LocalTranscriptLog`):
    // `role: "user"` marks a prompt typed by the human; `summary` is a tool call's
    // one-line summary shown in the header (the body is then the full input);
    // `result` / `resultIsError` fold the tool's result under its call.
    private var isUser: Bool { entry.metadata?["role"]?.stringValue == "user" }
    /// `role: "prompt"`: the prompt the session started with (the New work form,
    /// an automation's template), not a turn typed into it.
    private var isPrompt: Bool { entry.metadata?["role"]?.stringValue == "prompt" }
    /// `source` on a `.system` entry: what put a non-human turn in the conversation
    /// (a background task, another agent, a compaction, an interruption).
    private var systemSource: String? { entry.metadata?["source"]?.stringValue }
    private var summary: String? { entry.metadata?["summary"]?.stringValue }
    private var pairedResult: String? { entry.metadata?["result"]?.stringValue }
    private var isError: Bool {
        entry.metadata?["resultIsError"]?.boolValue == true || (entry.metadata?["exitCode"]?.intValue ?? 0) != 0
    }
    private var hasBody: Bool { !entry.content.isEmpty || pairedResult != nil }

    private var userBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: isPrompt ? "doc.text" : "person.fill")
                .font(.caption2)
                .foregroundStyle(isPrompt ? AnyShapeStyle(.secondary) : AnyShapeStyle(AppTheme.accent))
                .frame(width: 22, height: 22)
                .background(isPrompt ? AnyShapeStyle(.fill.tertiary) : AnyShapeStyle(AppTheme.accent.opacity(0.15)), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(isPrompt ? "Prompt" : "You")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(isPrompt ? AnyShapeStyle(.secondary) : AnyShapeStyle(AppTheme.accent))
                    if let time = Self.shortTime(entry.timestamp) {
                        Text(time).font(.caption2).foregroundStyle(.tertiary).monospacedDigit()
                    }
                }
                Text(entry.content)
                    .font(.callout)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .background(.fill.tertiary, in: Radius.cardShape)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// A turn the agent CLI filed as the person's but isn't. The first line reads
    /// inline; the rest (a task's result, a compaction summary) folds away.
    private var systemNote: some View {
        let (label, icon, folds) = Self.systemTurn(systemSource ?? "other")
        let text = entry.content
        let newline = text.firstIndex(of: "\n")
        let head = folds ? label : "\(label) · \(newline.map { String(text[..<$0]) } ?? text)"
        let rest = folds ? text : newline.map { String(text[text.index(after: $0)...]).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        return VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    if !rest.isEmpty {
                        Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
                    }
                    Image(systemName: icon).font(.caption2)
                    Text(head).font(.caption).lineLimit(expanded ? nil : 2).multilineTextAlignment(.leading)
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(rest.isEmpty)
            if expanded, !rest.isEmpty {
                Text(rest)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        .background(.fill.quaternary, in: Radius.cardShape)
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// Label, SF Symbol, and whether the whole text folds away, per `source`.
    private static func systemTurn(_ source: String) -> (String, String, Bool) {
        switch source {
        case "task": return ("Background task", "bell", false)
        case "agent": return ("Message from another agent", "person.2", false)
        case "compact": return ("Earlier conversation summarized", "rectangle.compress.vertical", true)
        case "interrupt": return ("Interrupted", "nosign", false)
        case "rewind": return ("Rolled back", "arrow.uturn.backward", false)
        default: return ("From the agent CLI", "info.circle", true)
        }
    }

    private static let timeFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateStyle = .none
        f.timeStyle = .short
        return f
    }()

    private static func shortTime(_ iso: String) -> String? {
        guard !iso.isEmpty else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        return date.map { timeFormatter.string(from: $0) }
    }

    @ViewBuilder
    private var toolBody: some View {
        VStack(alignment: .leading, spacing: 6) {
            if !entry.content.isEmpty {
                Text(entry.content)
                    .font(.caption.monospaced())
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.fill.tertiary, in: Radius.smallShape)
            }
            if let pairedResult {
                Text(pairedResult.isEmpty ? "(no output)" : pairedResult)
                    .font(.caption.monospaced())
                    .foregroundStyle(isError ? Tone.danger.textStyle : AnyShapeStyle(.secondary))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(8)
                    .background(.fill.quaternary, in: Radius.smallShape)
            }
        }
    }

    private var toolLabel: some View {
        HStack(spacing: 6) {
            Image(systemName: isError ? "exclamationmark.circle" : entry.type == .toolUse ? "wrench.and.screwdriver" : "arrow.turn.down.left")
                .foregroundStyle(isError ? Tone.danger.textStyle : AnyShapeStyle(.secondary))
            Text(toolName)
                .font(.caption.weight(.semibold).monospaced())
                .foregroundStyle(isError ? Tone.danger.textStyle : AnyShapeStyle(.primary))
            if let exit = entry.metadata?["exitCode"]?.intValue, exit != 0 {
                Text("exit \(exit)").font(.caption2).foregroundStyle(.red)
            }
            Spacer(minLength: 4)
            Text((summary ?? entry.content).prefix(80).replacingOccurrences(of: "\n", with: " "))
                .font(.caption2.monospaced())
                .foregroundStyle(.tertiary)
                .lineLimit(1)
        }
    }

    @ViewBuilder
    private var toolBlock: some View {
        if hasBody {
            DisclosureGroup(isExpanded: $expanded) { toolBody } label: { toolLabel }
                .tint(.secondary)
        } else {
            toolLabel.padding(.leading, 2)
        }
    }
}

/// Text field + send button pinned above the keyboard. `onSend` receives trimmed text.
struct ChatComposer: View {
    var placeholder = "Message"
    var disabled = false
    /// Raise the keyboard on appear (deep links with `compose=1`).
    var autofocus = false
    var onSend: (String) async -> Void
    @State private var text = ""
    @State private var sending = false
    @FocusState private var focused: Bool

    var body: some View {
        HStack(alignment: .bottom, spacing: Spacing.s) {
            TextField(placeholder, text: $text, axis: .vertical)
                .lineLimit(1...6)
                .textFieldStyle(.plain)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(.fill.tertiary, in: Radius.bubbleShape)
                .focused($focused)
                .disabled(disabled)
            Button {
                Task { await send() }
            } label: {
                Group {
                    if sending { ProgressView().tint(.white) } else { Image(systemName: "arrow.up").font(.body.weight(.semibold)) }
                }
                .frame(width: 36, height: 36)
                .foregroundStyle(.white)
                .background(canSend ? AppTheme.accent : Color(.tertiaryLabel), in: Circle())
            }
            .buttonStyle(.plain)
            .disabled(!canSend)
            .accessibilityLabel("Send")
        }
        .padding(.horizontal, Spacing.l)
        .padding(.vertical, Spacing.s)
        .background(composerBackground)
        .onAppear { if autofocus { focused = true } }
        .sensoryFeedback(.impact(flexibility: .soft), trigger: sending) { _, new in new }
    }

    private var canSend: Bool { !disabled && !sending && !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }

    @ViewBuilder
    private var composerBackground: some View {
        if #available(iOS 26, *) {
            Rectangle().fill(.clear).glassEffect(.regular, in: Rectangle())
        } else {
            Rectangle().fill(.bar)
        }
    }

    private func send() async {
        let msg = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !msg.isEmpty else { return }
        sending = true
        text = ""
        await onSend(msg)
        sending = false
    }
}
