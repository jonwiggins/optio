import SwiftUI

/// Renders a transcript of `AgentLogEntry` rows the way the web log viewer does:
/// assistant text as prose, tool calls as collapsible monospace blocks, thinking
/// dimmed, errors red. Used for task logs, job run logs, review logs, session chat
/// and persistent-agent turns alike so every surface reads the same.
struct AgentLogView: View {
    let entries: [AgentLogEntry]
    var autoScroll = true
    /// Fold each turn's in-between work (tool calls, thinking, running
    /// commentary) into one row, leaving what was said and the last reply —
    /// `AgentLogFold`.
    var foldSteps = false
    /// The log ends before the first entry: offer to load earlier ones.
    var onLoadEarlier: (() async -> Void)?
    var loadingEarlier = false
    /// The last steps row is the agent at work: it shows the step it's on.
    var working = false
    /// The reader is at the end: new entries scroll into view. Once they scroll
    /// up to read back, a live log stops pulling them down.
    @State private var atBottom = true
    @State private var blocks: [AgentLogBlock] = []

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    if let onLoadEarlier {
                        Button {
                            Task { await onLoadEarlier() }
                        } label: {
                            HStack(spacing: 6) {
                                if loadingEarlier { ProgressView().controlSize(.mini) }
                                Text("Load earlier messages")
                            }
                            .font(.caption.weight(.medium))
                            .frame(maxWidth: .infinity)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.small)
                        .disabled(loadingEarlier)
                    }
                    if foldSteps {
                        ForEach(blocks, id: \.id) { block in
                            switch block {
                            case .entry(let i):
                                AgentLogRow(entry: entries[i]).id(block.id)
                            case .steps(let range):
                                AgentLogStepsRow(
                                    entries: entries[range],
                                    working: working && block == blocks.last
                                )
                                .id(block.id)
                            }
                        }
                    } else {
                        ForEach(Array(entries.enumerated()), id: \.offset) { idx, entry in
                            AgentLogRow(entry: entry).id(idx)
                        }
                    }
                    // iOS 17 has no scroll geometry: the end coming into view stands in.
                    Color.clear.frame(height: 1)
                        .onAppear { if #unavailable(iOS 18.0) { atBottom = true } }
                        .onDisappear { if #unavailable(iOS 18.0) { atBottom = false } }
                }
                .padding()
            }
            // Open at the end, and stay there as the content grows while the
            // reader is at it: a lazy stack's rows aren't laid out yet when
            // the first `scrollTo` runs, so the anchor is what lands it.
            .defaultScrollAnchor(autoScroll ? .bottom : .top)
            .modifier(TracksBottom(atBottom: $atBottom))
            .overlay(alignment: .bottomTrailing) {
                Group {
                    if !atBottom, let last = lastId {
                        Button {
                            withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                        } label: {
                            Image(systemName: "arrow.down")
                                .font(.body.weight(.semibold))
                                .frame(width: 36, height: 36)
                                .background(.regularMaterial, in: Circle())
                                .overlay(Circle().strokeBorder(.quaternary))
                                .shadow(color: .black.opacity(0.15), radius: 4, y: 2)
                        }
                        .buttonStyle(.plain)
                        .padding(Spacing.m)
                        .accessibilityLabel("Scroll to the end")
                        .transition(.scale(scale: 0.8).combined(with: .opacity))
                    }
                }
                .animation(.snappy(duration: 0.2), value: atBottom)
            }
            .onChange(of: entries.count, initial: true) { old, count in
                if foldSteps { blocks = AgentLogFold.blocks(entries) }
                // Land at the end when the log first loads; after that, follow
                // only a reader who is already there.
                guard autoScroll, count > 0, old == 0 || atBottom else { return }
                guard let last = lastId else { return }
                if old == count {
                    proxy.scrollTo(last, anchor: .bottom)
                } else {
                    withAnimation { proxy.scrollTo(last, anchor: .bottom) }
                }
            }
        }
    }

    /// The id of the last row, the target of "to the end".
    private var lastId: Int? {
        if foldSteps { return blocks.last?.id }
        return entries.isEmpty ? nil : entries.count - 1
    }
}

/// One row of a folded log: an entry, or a run of steps (indices into the entries).
enum AgentLogBlock: Hashable {
    case entry(Int)
    case steps(Range<Int>)

    /// The first entry's index: stays put as a turn grows.
    var id: Int {
        switch self {
        case .entry(let i): return i
        case .steps(let r): return r.lowerBound
        }
    }
}

/// Port of `foldTranscript()` in the web's `transcript-view.tsx`. What reads as
/// the conversation: what you (or a background task, another agent, a
/// compaction) put in, and the agent's last reply to it. Everything between —
/// tool calls, thinking, the agent's running commentary — folds into one
/// steps row, so a turn with a hundred tool calls reads as your message, one
/// folded line, and the answer.
enum AgentLogFold {
    static func blocks(_ entries: [AgentLogEntry]) -> [AgentLogBlock] {
        var out: [AgentLogBlock] = []
        func pushSteps(_ r: Range<Int>) {
            if r.count == 1 { out.append(.entry(r.lowerBound)) } else if r.count > 1 { out.append(.steps(r)) }
        }
        // Per turn (what follows each opener): the steps before its last reply,
        // the reply, then the steps after it — a turn still at work has those.
        func flush(_ turn: Range<Int>) {
            guard let reply = turn.last(where: { isReply(entries[$0]) }) else {
                pushSteps(turn)
                return
            }
            pushSteps(turn.lowerBound..<reply)
            out.append(.entry(reply))
            pushSteps((reply + 1)..<turn.upperBound)
        }
        var start = 0
        for (i, e) in entries.enumerated() where opensTurn(e) {
            flush(start..<i)
            out.append(.entry(i))
            start = i + 1
        }
        flush(start..<entries.count)
        return out
    }

    static func opensTurn(_ e: AgentLogEntry) -> Bool {
        switch e.type {
        case .text: return e.metadata?["role"]?.stringValue != nil
        case .system: return e.metadata?["source"]?.stringValue != nil
        default: return false
        }
    }

    static func isReply(_ e: AgentLogEntry) -> Bool {
        e.type == .text && e.metadata?["role"]?.stringValue == nil
    }

    /// "12 tool calls · 3 messages · thinking".
    static func summary(_ entries: ArraySlice<AgentLogEntry>) -> String {
        var tools = 0, messages = 0, thinking = 0
        for e in entries {
            switch e.type {
            case .toolUse, .toolResult: tools += 1
            case .thinking: thinking += 1
            default: messages += 1
            }
        }
        func plural(_ n: Int, _ noun: String) -> String { "\(n) \(noun)\(n == 1 ? "" : "s")" }
        return [
            tools > 0 ? plural(tools, "tool call") : nil,
            messages > 0 ? plural(messages, "message") : nil,
            thinking > 0 ? "thinking" : nil,
        ].compactMap { $0 }.joined(separator: " · ")
    }

    static func failures(_ entries: ArraySlice<AgentLogEntry>) -> Int {
        entries.filter { $0.metadata?["resultIsError"]?.boolValue == true || $0.type == .error }.count
    }
}

/// A turn's in-between work folded to one line — what it holds, and while the
/// agent is at it the step it's on. Open, every step reads as its own row.
struct AgentLogStepsRow: View {
    let entries: ArraySlice<AgentLogEntry>
    var working = false
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Button {
                withAnimation(.snappy) { expanded.toggle() }
            } label: {
                HStack(spacing: 6) {
                    Image(systemName: expanded ? "chevron.down" : "chevron.right").font(.caption2)
                    Image(systemName: "wrench.and.screwdriver").font(.caption2)
                    Text(AgentLogFold.summary(entries)).font(.caption)
                    let failed = AgentLogFold.failures(entries)
                    if failed > 0 {
                        Text("· \(failed) failed").font(.caption).foregroundStyle(Tone.danger.textStyle)
                    }
                    if working, !expanded, let current {
                        Text("· \(current)")
                            .font(.caption2.monospaced())
                            .foregroundStyle(.tertiary)
                            .lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
                .foregroundStyle(.secondary)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("\(AgentLogFold.summary(entries)), \(expanded ? "expanded" : "collapsed")")
            if expanded {
                ForEach(entries.indices, id: \.self) { i in
                    AgentLogRow(entry: entries[i])
                }
                .padding(.leading, 10)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    /// The last step, while working: "Shell · npm test".
    private var current: String? {
        guard let last = entries.last, last.type == .toolUse else { return nil }
        let name = last.metadata?["toolName"]?.stringValue ?? "tool"
        let summary = (last.metadata?["summary"]?.stringValue ?? "").replacingOccurrences(of: "\n", with: " ")
        return summary.isEmpty ? name : "\(name) · \(summary.prefix(60))"
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
                .submitLabel(.send)
                // A vertical-axis field turns Return into a newline rather
                // than a submit. The keyboard's Send key is the send: catch
                // the newline it inserted and send the message instead.
                .onChange(of: text) { old, new in
                    guard new == old + "\n" else { return }
                    text = old
                    Task { await send() }
                }
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
