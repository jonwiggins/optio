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

    private var toolBlock: some View {
        DisclosureGroup(isExpanded: $expanded) {
            Text(entry.content)
                .font(.caption.monospaced())
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(8)
                .background(.fill.tertiary, in: Radius.smallShape)
        } label: {
            HStack(spacing: 6) {
                Image(systemName: entry.type == .toolUse ? "wrench.and.screwdriver" : "arrow.turn.down.left")
                Text(toolName).font(.caption.weight(.semibold).monospaced())
                if let exit = entry.metadata?["exitCode"]?.intValue, exit != 0 {
                    Text("exit \(exit)").font(.caption2).foregroundStyle(.red)
                }
                Spacer()
                Text(entry.content.prefix(60).replacingOccurrences(of: "\n", with: " "))
                    .font(.caption2.monospaced())
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
        .tint(.secondary)
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
