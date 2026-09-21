import SwiftUI
import UIKit

// The pieces the work form is built from, all shaped like native Form
// rows so the screen reads as one system: a sentence-case section header, an
// exclusive-choice row with a checkmark, a menu row that looks like a menu
// picker but can disable an item with a reason, a right-aligned value field,
// chip rows, and a prompt editor that grows with its text and can insert a
// `{{param}}` at the caret.

/// Scroll anchors for the sentence's "missing" pieces and the dev script.
enum WorkFormAnchor: Hashable {
    case when, `where`, who, prompt, then, name

    static func forField(_ f: WorkForm.SentenceField) -> WorkFormAnchor {
        switch f {
        case .cron, .webhook: return .when
        case .checkout, .repo, .machine: return .where
        case .prompt: return .prompt
        }
    }
}

// MARK: - Section header

/// "When · What starts it?" — the attribute in the app's section-header style
/// with the question after it. Sentence case: a bare string header would be
/// uppercased by the grouped list style.
struct FormSectionHeader<Trailing: View>: View {
    let title: String
    var question: String? = nil
    var anchor: WorkFormAnchor? = nil
    @ViewBuilder var trailing: Trailing

    init(_ title: String, question: String? = nil, anchor: WorkFormAnchor? = nil, @ViewBuilder trailing: () -> Trailing = { EmptyView() }) {
        self.title = title
        self.question = question
        self.anchor = anchor
        self.trailing = trailing()
    }

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: Spacing.s) {
            Text(title).font(.sectionHeader).foregroundStyle(Color(.secondaryLabel))
            if let question {
                Text(question).font(.footnote).foregroundStyle(Color(.tertiaryLabel)).lineLimit(1)
            }
            Spacer(minLength: 0)
            trailing
        }
        .textCase(nil)
        .id(anchor)
    }
}

// MARK: - Choice row

/// One of an exclusive set (the web's `ModeCard` / `LocationCard`), as the
/// row Settings uses for a pick-one list: symbol, title, one-line subtitle,
/// checkmark on the chosen one. A choice that can't be picked dims and says why.
struct ChoiceRow: View {
    let systemImage: String
    let title: String
    var subtitle: String? = nil
    let selected: Bool
    var disabled: String? = nil
    let onTap: () -> Void

    private var enabled: Bool { disabled == nil }

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: Spacing.m) {
                Image(systemName: systemImage)
                    .font(.body)
                    .symbolRenderingMode(.hierarchical)
                    .foregroundStyle(enabled ? (selected ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary)) : AnyShapeStyle(.quaternary))
                    .frame(width: 26)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title).font(.body).foregroundStyle(enabled ? AnyShapeStyle(.primary) : AnyShapeStyle(.tertiary))
                    if let disabled {
                        Text(disabled).font(.footnote).foregroundStyle(.tertiary).fixedSize(horizontal: false, vertical: true)
                    } else if let subtitle {
                        Text(subtitle).font(.footnote).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
                    }
                }
                Spacer(minLength: Spacing.s)
                if selected {
                    Image(systemName: "checkmark").font(.body.weight(.semibold)).foregroundStyle(AppTheme.accent)
                        .transition(.scale.combined(with: .opacity))
                }
            }
            .padding(.vertical, 2)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!enabled)
        .accessibilityLabel(title)
        .accessibilityHint(disabled ?? subtitle ?? "")
        .accessibilityAddTraits(selected ? .isSelected : [])
    }
}

// MARK: - Menu row

/// A row shaped like a menu `Picker` — label, current value, up/down chevron —
/// whose items are ordinary menu buttons, so one can carry a checkmark, a
/// subtitle, a section, or be disabled.
struct MenuRow<Items: View>: View {
    let label: String
    let value: String
    /// The value is a prompt ("Pick a directory…"), not an answer.
    var placeholder = false
    var mono = false
    @ViewBuilder let items: Items

    var body: some View {
        Menu {
            items
        } label: {
            HStack(spacing: Spacing.s) {
                Text(label).foregroundStyle(.primary)
                Spacer(minLength: Spacing.m)
                Text(value)
                    .font(mono && !placeholder ? .monoSubheadline : .body)
                    .foregroundStyle(placeholder ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                    .lineLimit(1)
                    .truncationMode(mono ? .head : .tail)
                    .multilineTextAlignment(.trailing)
                Image(systemName: "chevron.up.chevron.down")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
        .accessibilityValue(value)
    }
}

/// A menu item that shows a checkmark when it is the current value.
struct MenuChoice: View {
    let title: String
    var subtitle: String? = nil
    let selected: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            if selected { Label(title, systemImage: "checkmark") } else { Text(title) }
            if let subtitle { Text(subtitle) }
        }
    }
}

// MARK: - Fields

/// A short value on the trailing side of its label, the way Settings edits a
/// hostname or an address: "Branch        main".
struct ValueField: View {
    let label: String
    let placeholder: String
    @Binding var text: String
    var mono = true
    var prefix: String? = nil

    var body: some View {
        HStack(spacing: Spacing.s) {
            Text(label)
            Spacer(minLength: Spacing.m)
            if let prefix {
                Text(prefix).font(.monoSubheadline).foregroundStyle(.tertiary).lineLimit(1)
            }
            TextField(placeholder, text: $text)
                .font(mono ? .body.monospaced() : .body)
                .multilineTextAlignment(prefix == nil ? .trailing : .leading)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .frame(maxWidth: prefix == nil ? .infinity : 140, alignment: .trailing)
                .fixedSize(horizontal: prefix != nil, vertical: false)
        }
    }
}

// MARK: - Chips

/// One chip in a horizontal `ChipRow`.
struct Chip<T: Hashable>: Hashable {
    let value: T
    let label: String
    var systemImage: String? = nil
}

/// Chips that scroll edge to edge inside a row; the selected one is the
/// app's inverted primary pill. Optional symbol for the presets.
struct ChipRow<T: Hashable>: View {
    let chips: [Chip<T>]
    let selection: T?
    var mono = false
    let onSelect: (T) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: Spacing.s) {
                ForEach(chips, id: \.self) { chip in
                    let selected = chip.value == selection
                    Button { onSelect(chip.value) } label: {
                        HStack(spacing: 5) {
                            if let img = chip.systemImage { Image(systemName: img).font(.caption.weight(.medium)) }
                            Text(chip.label)
                        }
                        .font(mono ? .monoFootnote : .subheadline.weight(selected ? .semibold : .regular))
                        .foregroundStyle(selected ? Color(.systemBackground) : Color.primary)
                        .padding(.horizontal, Spacing.m)
                        .padding(.vertical, 7)
                        .background(selected ? AnyShapeStyle(Color.primary) : AnyShapeStyle(.fill.tertiary), in: Capsule())
                        .contentShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(selected ? .isSelected : [])
                }
            }
            .padding(.horizontal, Spacing.l)
            .padding(.vertical, Spacing.s)
        }
        .scrollClipDisabled()
        .listRowInsets(EdgeInsets())
        .sensoryFeedback(.selection, trigger: selection)
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

    func dismissKeyboard() { textView?.resignFirstResponder() }
}

/// UITextView-backed editor: body text, no autocorrect on `{{params}}`, grows
/// with its content (the form scrolls, not the field), keeps the caret so
/// chips can insert.
struct PromptTextView: UIViewRepresentable {
    @Binding var text: String
    let controller: PromptEditorController
    var minHeight: CGFloat = 128

    func makeUIView(context: Context) -> UITextView {
        let tv = UITextView()
        tv.font = .preferredFont(forTextStyle: .body)
        tv.adjustsFontForContentSizeCategory = true
        tv.backgroundColor = .clear
        tv.isScrollEnabled = false
        tv.autocorrectionType = .default
        tv.autocapitalizationType = .sentences
        tv.smartQuotesType = .no
        tv.smartDashesType = .no
        tv.textContainerInset = UIEdgeInsets(top: 10, left: 0, bottom: 10, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        tv.setContentCompressionResistancePriority(.defaultLow, for: .horizontal)
        tv.delegate = context.coordinator
        tv.text = text
        controller.textView = tv
        return tv
    }

    func updateUIView(_ tv: UITextView, context: Context) {
        if tv.text != text {
            tv.text = text
            tv.invalidateIntrinsicContentSize()
        }
        controller.textView = tv
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: UITextView, context: Context) -> CGSize? {
        guard let width = proposal.width, width > 0 else { return nil }
        let fitted = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: max(minHeight, fitted.height.rounded(.up)))
    }

    func makeCoordinator() -> Coordinator { Coordinator(text: $text) }

    final class Coordinator: NSObject, UITextViewDelegate {
        var text: Binding<String>
        init(text: Binding<String>) { self.text = text }
        func textViewDidChange(_ tv: UITextView) {
            text.wrappedValue = tv.text
            tv.invalidateIntrinsicContentSize()
        }
    }
}

/// The prompt: growing editor with a placeholder, laid out as a Form row.
struct PromptEditor: View {
    @Binding var text: String
    let placeholder: String
    let controller: PromptEditorController

    var body: some View {
        ZStack(alignment: .topLeading) {
            if text.isEmpty {
                Text(placeholder)
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.top, 10)
                    .allowsHitTesting(false)
                    .accessibilityHidden(true)
            }
            PromptTextView(text: $text, controller: controller)
        }
        .accessibilityLabel("Prompt")
    }
}
