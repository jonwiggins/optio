import SwiftUI

/// The one creation form, native. A grouped Form with six sections in
/// dependency order — When, Where, Who, What, Then, Name — each narrowing the
/// next, example presets up top, and one bar pinned at the bottom that says
/// in a sentence what you're about to make and holds the button that makes
/// it. There is no "type" to pick: the row it becomes is derived from the
/// answers (`SessionForm.deriveKind`).
struct SessionFormView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var state: SessionFormState?
    @State private var editor = PromptEditorController()

    var body: some View {
        NavigationStack {
            Group {
                if let state {
                    FormBody(state: state, editor: editor, onCreated: handleCreated)
                } else {
                    ProgressView().frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .navigationTitle("New session")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItemGroup(placement: .keyboard) {
                    Spacer()
                    Button("Done") { hideKeyboard() }.font(.body.weight(.semibold))
                }
            }
            .task {
                if state == nil {
                    let s = SessionFormState(api: api)
                    state = s
                    await s.load()
                    #if DEBUG
                    s.applyDevScript()
                    #endif
                }
            }
        }
        .interactiveDismissDisabled(state?.submitting ?? false)
    }

    private func handleCreated(_ created: SessionForm.Created) {
        NotificationCenter.default.post(name: .optioSessionCreated, object: nil)
        router.showCreatedSession(created.destination, toast: created.toast)
        dismiss()
    }

    private func hideKeyboard() {
        editor.dismissKeyboard()
        UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil)
    }
}

extension Notification.Name {
    /// A session was created from the form; feeds that show sessions should refresh.
    static let optioSessionCreated = Notification.Name("optio.sessionCreated")
}

private struct FormBody: View {
    @Bindable var state: SessionFormState
    let editor: PromptEditorController
    let onCreated: (SessionForm.Created) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            Form {
                PresetsRow(state: state)
                WhenSection(state: state)
                WhereSection(state: state)
                WhoSection(state: state)
                if !state.isTerminal { WhatSection(state: state, editor: editor) }
                ThenSection(state: state)
                NameSection(state: state)
            }
            .scrollDismissesKeyboard(.interactively)
            .tint(AppTheme.accent)
            .animation(.snappy, value: state.draft.when)
            .animation(.snappy, value: state.draft.then)
            .animation(.snappy, value: state.isLocal)
            .animation(.snappy, value: state.draft.withRepo)
            .animation(.snappy, value: state.isTerminal)
            .safeAreaInset(edge: .bottom, spacing: 0) {
                SubmitBar(state: state, onCreated: onCreated) { field in
                    withAnimation(.snappy) { proxy.scrollTo(SessionFormAnchor.forField(field), anchor: .top) }
                }
            }
            .navigationDestination(isPresented: $state.showDeps) {
                DependenciesPicker(state: state, tasks: state.existingTasks.filter { !["completed", "cancelled"].contains($0.state) })
            }
            .task(id: state.submitRequest) {
                guard state.submitRequest else { return }
                try? await Task.sleep(for: .seconds(1))
                let created = await state.submit()
                state.submitRequest = false
                if let created { onCreated(created) }
            }
            .onChange(of: state.scrollRequest) { _, anchor in
                guard let anchor else { return }
                Task { @MainActor in
                    try? await Task.sleep(for: .milliseconds(400))
                    withAnimation(.snappy) { proxy.scrollTo(anchor, anchor: .top) }
                    state.scrollRequest = nil
                }
            }
        }
        .errorToast(Binding(get: { state.error }, set: { state.error = $0 }))
    }
}

// MARK: - Presets

/// Examples that fill the form in — a row of chips, not a setting.
private struct PresetsRow: View {
    @Bindable var state: SessionFormState

    var body: some View {
        Section {
            ChipRow(
                chips: SessionForm.presets.map { Chip(value: $0.id, label: $0.label, systemImage: $0.systemImage) },
                selection: state.preset
            ) { id in withAnimation(.snappy) { state.applyPreset(id) } }
            .listRowBackground(Color.clear)
            .listRowInsets(EdgeInsets())
        } header: {
            FormSectionHeader("Start from an example")
        }
        .listSectionSpacing(.compact)
    }
}

// MARK: - Sentence + submit

/// Pinned under the form: the live description of what the answers make —
/// missing pieces are tappable and scroll to their section — and the one
/// button that makes it.
private struct SubmitBar: View {
    @Bindable var state: SessionFormState
    let onCreated: (SessionForm.Created) -> Void
    let onJump: (SessionForm.SentenceField) -> Void

    @State private var nudges = 0

    private var ready: Bool { state.gaps.isEmpty && (!state.wantsRepoUrl || !state.effectiveRepoUrl.isEmpty) }
    private var firstGap: SessionForm.SentenceField? {
        if let g = state.gaps.first { return g }
        if state.wantsRepoUrl, state.effectiveRepoUrl.isEmpty { return state.isLocal ? .checkout : .repo }
        return nil
    }

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.m) {
            Text(sentence)
                .font(.footnote)
                .lineSpacing(2)
                .frame(maxWidth: .infinity, alignment: .leading)
                .environment(\.openURL, OpenURLAction { url in
                    if url.scheme == "optio-form", let raw = url.host(), let field = SessionForm.SentenceField(rawValue: raw) {
                        onJump(field)
                        return .handled
                    }
                    return .systemAction
                })
                .accessibilityLabel(SessionForm.sentenceText(state.sentence))
                .animation(.snappy, value: state.sentence)
            // Never a washed-out disabled button: while something is missing the
            // button goes grey and a tap takes you to the first gap.
            Button {
                if state.canSubmit {
                    Task { if let created = await state.submit() { onCreated(created) } }
                } else if let field = firstGap {
                    nudges += 1
                    onJump(field)
                }
            } label: {
                HStack(spacing: Spacing.s) {
                    if state.submitting { ProgressView().tint(.white) }
                    Text(state.submitting ? "Creating…" : state.submitLabel).lineLimit(1)
                }
                .font(.body.weight(.semibold))
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
            }
            .glassProminentButton()
            .controlSize(.large)
            .tint(ready ? AppTheme.accent : Color(.systemGray2))
            .disabled(state.submitting)
            .animation(.snappy, value: ready)
            .sensoryFeedback(.warning, trigger: nudges)
            .accessibilityHint(ready ? "" : "Something is still missing; tap to go to it.")
        }
        .padding(.horizontal, Spacing.l)
        .padding(.top, Spacing.m)
        .padding(.bottom, Spacing.s)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }

    /// The sentence, plus what it can't say — a missing prompt, a directory
    /// with no git remote — as one more tappable gap.
    private var sentence: AttributedString {
        var out = AttributedString()
        for (i, part) in state.sentence.enumerated() {
            switch part {
            case .text(let s):
                let punct = s.hasPrefix(",") || s.hasPrefix(".")
                var a = AttributedString((i > 0 && !punct ? " " : "") + s)
                a.foregroundColor = ready ? Color.primary : Color(.secondaryLabel)
                out += a
            case .missing(let s, let field):
                if i > 0 { out += AttributedString(" ") }
                out += gap(s, field)
            }
        }
        var needs = AttributedString(" Needs ")
        needs.foregroundColor = Color(.secondaryLabel)
        var stop = AttributedString(".")
        stop.foregroundColor = Color(.secondaryLabel)
        if state.gaps.contains(.prompt) {
            out += needs + gap("a prompt", .prompt) + stop
        } else if state.wantsRepoUrl, state.effectiveRepoUrl.isEmpty, !state.gaps.contains(.checkout) {
            out += needs + gap(state.isLocal ? "a git checkout" : "a repo", state.isLocal ? .checkout : .repo) + stop
        }
        return out
    }

    private func gap(_ s: String, _ field: SessionForm.SentenceField) -> AttributedString {
        var a = AttributedString(s)
        a.foregroundColor = StatusColor.yellow
        a.font = .footnote.weight(.semibold)
        a.underlineStyle = .single
        a.link = URL(string: "optio-form://\(field.rawValue)")
        return a
    }
}
