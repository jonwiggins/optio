import SwiftUI
import UIKit

// The small pieces the session form is built from: a labelled section, pill
// rows that can disable a choice with a reason, mode cards, and a prompt
// editor that can insert `{{param}}` at the caret.

/// One card per attribute (`Section` in session-form.tsx): a numbered header
/// strip that names the question and echoes the current answer, and one body
/// holding every control for it. Controls inside separate with dividers.
struct FormSection<Content: View>: View {
    let step: Int
    let label: String
    var hint: String? = nil
    var summary: String? = nil
    var id: SessionFormAnchor? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            HStack(spacing: Spacing.s) {
                Text("\(step)")
                    .font(.caption2.weight(.semibold)).monospacedDigit()
                    .foregroundStyle(AppTheme.accent)
                    .frame(width: 20, height: 20)
                    .background(AppTheme.accent.opacity(0.15), in: Circle())
                Text(label).font(.subheadline.weight(.semibold))
                // The question, while there is room: once an answer summary is shown the
                // phone-width header keeps the answer and drops the hint.
                if let hint, summary == nil { Text(hint).font(.caption).foregroundStyle(.secondary).lineLimit(1) }
                Spacer(minLength: Spacing.s)
                if let summary {
                    Text(summary).font(.caption).foregroundStyle(.secondary).lineLimit(1).truncationMode(.tail)
                        .layoutPriority(1)
                        .frame(maxWidth: 190, alignment: .trailing)
                }
            }
            .padding(.horizontal, Spacing.m).padding(.vertical, 9)
            .background(Color(.tertiarySystemGroupedBackground).opacity(0.6))
            Divider()
            VStack(alignment: .leading, spacing: Spacing.m) { content }
                .padding(Spacing.m)
        }
        .background(Surface.card, in: Radius.cardShape)
        .clipShape(Radius.cardShape)
        .id(id)
    }
}

/// Scroll anchors for the sentence's "missing" chips.
enum SessionFormAnchor: Hashable {
    case when, `where`, who, prompt, then, name

    static func forField(_ f: SessionForm.SentenceField) -> SessionFormAnchor {
        switch f {
        case .cron, .webhook: return .when
        case .checkout, .repo, .machine: return .where
        case .prompt: return .prompt
        }
    }
}

/// One choice in a `PillRow`.
struct Pill<T: Hashable>: Hashable {
    let value: T
    let label: String
    var systemImage: String? = nil
    var disabled: String? = nil
}

/// Wrapping pills; a disabled pill dims and, on tap, explains why.
struct PillRow<T: Hashable>: View {
    let pills: [Pill<T>]
    let selection: T
    let onSelect: (T) -> Void
    @State private var explain: String?

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.s) {
            FlowLayout(spacing: Spacing.s) {
                ForEach(pills, id: \.self) { pill in
                    let selected = pill.value == selection
                    Button {
                        if let why = pill.disabled { withAnimation(.snappy) { explain = why } }
                        else { withAnimation(.snappy) { explain = nil }; onSelect(pill.value) }
                    } label: {
                        HStack(spacing: 5) {
                            if let img = pill.systemImage { Image(systemName: img).font(.caption) }
                            Text(pill.label)
                        }
                        .font(.subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? Color(.systemBackground) : pill.disabled == nil ? Color.primary : Color(.tertiaryLabel))
                        .padding(.horizontal, Spacing.m)
                        .padding(.vertical, 7)
                        .background(selected ? AnyShapeStyle(Color.primary) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(pill.disabled ?? "")
                }
            }
            if let explain {
                Text(explain).font(.caption).foregroundStyle(Tone.accent.textStyle)
                    .transition(.opacity)
            }
        }
        .sensoryFeedback(.selection, trigger: selection)
    }
}

/// Either/or toggle (the web's `Segmented`).
struct SegmentedChoice<T: Hashable>: View {
    let options: [(T, String)]
    let selection: T
    let onSelect: (T) -> Void

    var body: some View {
        Picker("", selection: Binding(get: { selection }, set: onSelect)) {
            ForEach(options, id: \.0) { value, label in Text(label).tag(value) }
        }
        .pickerStyle(.segmented)
        .labelsHidden()
    }
}

/// The web's `ModeCard` / `LocationCard`: icon, title, subtitle, description;
/// disabled cards dim and carry the reason.
struct ChoiceCard: View {
    let systemImage: String
    let title: String
    var subtitle: String? = nil
    var description: String? = nil
    let active: Bool
    var disabled: String? = nil
    let onTap: () -> Void
    @State private var explain = false

    var body: some View {
        Button {
            if disabled != nil { withAnimation(.snappy) { explain.toggle() } } else { onTap() }
        } label: {
            HStack(alignment: .top, spacing: Spacing.m) {
                Image(systemName: systemImage)
                    .font(.title3)
                    .frame(width: 28)
                    .foregroundStyle(active ? AnyShapeStyle(AppTheme.accent) : disabled == nil ? AnyShapeStyle(.secondary) : AnyShapeStyle(.quaternary))
                    .padding(.top, 1)
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: Spacing.s) {
                        Text(title).font(.subheadline.weight(.semibold))
                        if let subtitle { Text(subtitle).font(.caption).foregroundStyle(.secondary) }
                    }
                    if let description {
                        Text(description).font(.caption).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                    if let disabled, explain || active {
                        Text(disabled).font(.caption).foregroundStyle(Tone.accent.textStyle).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: active ? "checkmark.circle.fill" : "circle")
                    .foregroundStyle(active ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.quaternary))
            }
            .padding(Spacing.m)
            .background(Color(.tertiarySystemGroupedBackground), in: Radius.innerShape)
            .overlay(Radius.innerShape.strokeBorder(active ? AppTheme.accent.opacity(0.6) : .clear, lineWidth: 1.5))
            .opacity(disabled == nil || active ? 1 : 0.55)
            .contentShape(Radius.innerShape)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityHint(disabled ?? description ?? "")
        .accessibilityAddTraits(active ? .isSelected : [])
    }
}

/// Small inline label above a field.
struct FieldLabel: View {
    let text: String
    var optional = false
    var body: some View {
        HStack(spacing: 4) {
            Text(text).font(.footnote).foregroundStyle(.secondary)
            if optional { Text("(optional)").font(.footnote).foregroundStyle(.tertiary) }
        }
    }
}

/// Footnote copy under a control.
struct Hint: View {
    let text: String
    var tone: Tone? = nil
    var body: some View {
        Text(text).font(.caption).foregroundStyle(tone?.textStyle ?? AnyShapeStyle(.tertiary)).fixedSize(horizontal: false, vertical: true)
    }
}

/// Plain rounded text field (single line) used inside cards.
struct CardTextField: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var body: some View {
        TextField(placeholder, text: $text)
            .font(mono ? .body.monospaced() : .body)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .padding(.horizontal, Spacing.m)
            .padding(.vertical, 9)
            .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
    }
}

/// Multi-line text in a card (system prompt, agents.md).
struct CardTextEditor: View {
    let placeholder: String
    @Binding var text: String
    var mono = false
    var minHeight: CGFloat = 80
    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).font(mono ? .footnote.monospaced() : .footnote).foregroundStyle(.tertiary)
                    .padding(.horizontal, Spacing.m + 4).padding(.vertical, 14)
                    .allowsHitTesting(false)
            }
            TextEditor(text: $text)
                .font(mono ? .footnote.monospaced() : .footnote)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, Spacing.s)
                .padding(.vertical, 6)
                .frame(minHeight: minHeight)
        }
        .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
    }
}

// MARK: - Prompt editor with caret insertion

/// Holds the live `UITextView` so a chip tap can insert at the caret.
@MainActor
final class PromptEditorController {
    weak var textView: UITextView?

    /// Insert `token` at the selection (replacing it); append when the view isn't live.
    func insert(_ token: String, into text: inout String) {
        let ns = text as NSString
        guard let tv = textView, tv.selectedRange.location != NSNotFound, NSMaxRange(tv.selectedRange) <= ns.length else {
            let sep = text.isEmpty || text.hasSuffix(" ") || text.hasSuffix("\n") ? "" : " "
            text += sep + token
            return
        }
        let sel = tv.selectedRange
        let updated = ns.replacingCharacters(in: sel, with: token)
        text = updated
        tv.text = updated
        tv.selectedRange = NSRange(location: sel.location + (token as NSString).length, length: 0)
        tv.becomeFirstResponder()
    }
}

/// UITextView-backed editor: mono, no autocorrect, keeps the caret so chips can insert.
struct PromptTextView: UIViewRepresentable {
    @Binding var text: String
    let controller: PromptEditorController

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.font = UIFont.monospacedSystemFont(ofSize: UIFont.preferredFont(forTextStyle: .footnote).pointSize, weight: .regular)
        tv.adjustsFontForContentSizeCategory = true
        tv.backgroundColor = .clear
        tv.autocorrectionType = .no
        tv.autocapitalizationType = .none
        tv.smartQuotesType = .no
        tv.smartDashesType = .no
        tv.textContainerInset = UIEdgeInsets(top: 12, left: 8, bottom: 12, right: 8)
        tv.delegate = context.coordinator
        tv.text = text
        controller.textView = tv
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if tv.text != text { tv.text = text }
        controller.textView = tv
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textViewDidChange(_ tv: UITextView) { text.wrappedValue = tv.text }
    }
}

/// The prompt: editor + placeholder, at a fixed comfortable height.
struct PromptEditor: View {
    @Binding var text: String
    let placeholder: String
    let controller: PromptEditorController

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder).font(.footnote.monospaced()).foregroundStyle(.tertiary)
                    .padding(.horizontal, Spacing.m + 1).padding(.vertical, 12)
                    .allowsHitTesting(false)
            }
            PromptTextView(text: $text, controller: controller)
                .frame(minHeight: 150, maxHeight: 260)
        }
        .background(Color(.tertiarySystemGroupedBackground), in: Radius.smallShape)
    }
}
