import SwiftUI

/// Renders a transcript of `AgentLogEntry` rows the way the web log viewer does:
/// assistant text as prose, tool calls as collapsible monospace blocks, thinking
/// dimmed, errors red. Used for task logs, job run logs, review logs, session chat
/// and persistent-agent turns alike so every surface reads the same.
struct AgentLogView: View {
    let entries: [AgentLogEntry]
    var autoScroll = true

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 10) {
                    ForEach(Array(entries.enumerated()), id: \.offset) { idx, entry in
                        AgentLogRow(entry: entry).id(idx)
                    }
                }
                .padding()
            }
            .onChange(of: entries.count) { _, count in
                guard autoScroll, count > 0 else { return }
                withAnimation { proxy.scrollTo(count - 1, anchor: .bottom) }
            }
        }
    }
}

struct AgentLogRow: View {
    let entry: AgentLogEntry
    @State private var expanded = false

    var body: some View {
        switch entry.type {
        case .text where isUser:
            userBubble
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
    private var summary: String? { entry.metadata?["summary"]?.stringValue }
    private var pairedResult: String? { entry.metadata?["result"]?.stringValue }
    private var isError: Bool {
        entry.metadata?["resultIsError"]?.boolValue == true || (entry.metadata?["exitCode"]?.intValue ?? 0) != 0
    }
    private var hasBody: Bool { !entry.content.isEmpty || pairedResult != nil }

    private var userBubble: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "person.fill")
                .font(.caption2)
                .foregroundStyle(AppTheme.accent)
                .frame(width: 22, height: 22)
                .background(AppTheme.accent.opacity(0.15), in: Circle())
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text("You").font(.caption.weight(.semibold)).foregroundStyle(AppTheme.accent)
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
