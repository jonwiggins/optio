import SwiftUI

/// The one creation form, native. Six groups in dependency order — When,
/// Where, Who, What, Exit conditions, Name — each narrowing the next, the
/// presets up top and a sentence pinned under the header that says what
/// you're about to make. There is no "type" to pick: the row it becomes is
/// derived from the answers (`WorkForm.deriveKind`).
struct WorkFormView: View {
    @Environment(APIClient.self) private var api
    @Environment(AppRouter.self) private var router
    @Environment(\.dismiss) private var dismiss
    @State private var state: WorkFormState?
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
            .navigationTitle("New work")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
            .task {
                if state == nil {
                    let s = WorkFormState(api: api)
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

    private func handleCreated(_ created: WorkForm.Created) {
        NotificationCenter.default.post(name: .optioSessionCreated, object: nil)
        router.showCreatedWork(created.destination, toast: created.toast)
        dismiss()
    }
}

extension Notification.Name {
    /// A session was created from the form; feeds that show sessions should refresh.
    static let optioSessionCreated = Notification.Name("optio.sessionCreated")
}

private struct FormBody: View {
    @Bindable var state: WorkFormState
    let editor: PromptEditorController
    let onCreated: (WorkForm.Created) -> Void

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: Spacing.l) {
                    Text("Everything Optio runs is work — a terminal, an agent run, a recurring job, a persistent agent. Say what starts it, where it runs, who drives it, what it does, and what happens when a turn ends.")
                        .font(.footnote).foregroundStyle(.secondary)
                    PresetsRow(state: state)
                    WhenSection(state: state)
                    WhereSection(state: state)
                    WhoSection(state: state)
                    if !state.isTerminal { WhatSection(state: state, editor: editor) }
                    ThenSection(state: state)
                    NameSection(state: state)
                    Color.clear.frame(height: Spacing.s)
                }
                .padding(.horizontal, Spacing.l)
                .padding(.top, Spacing.s)
            }
            .scrollDismissesKeyboard(.interactively)
            .background(Surface.page)
            .safeAreaInset(edge: .top, spacing: 0) {
                SentenceBanner(state: state) { field in
                    withAnimation(.snappy) { proxy.scrollTo(SessionFormAnchor.forField(field), anchor: .top) }
                }
            }
            .safeAreaInset(edge: .bottom, spacing: 0) { SubmitBar(state: state, onCreated: onCreated) }
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

/// Examples: shortcuts that fill the form in, not a setting — a line of text links.
private struct PresetsRow: View {
    @Bindable var state: WorkFormState

    var body: some View {
        VStack(alignment: .leading, spacing: Spacing.xs) {
            FlowLayout(spacing: 4) {
                Text("Examples:").font(.footnote).foregroundStyle(.secondary)
                ForEach(Array(WorkForm.presets.enumerated()), id: \.element.id) { i, p in
                    HStack(spacing: 4) {
                        if i > 0 { Text("·").font(.footnote).foregroundStyle(.quaternary) }
                        Button { withAnimation(.snappy) { state.applyPreset(p.id) } } label: {
                            Text(p.label)
                                .font(.footnote.weight(state.preset == p.id ? .semibold : .regular))
                                .foregroundStyle(state.preset == p.id ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary))
                                .underline(pattern: .dot, color: state.preset == p.id ? AppTheme.accent.opacity(0.6) : Color(.tertiaryLabel))
                        }
                        .buttonStyle(.plain)
                        .accessibilityHint(p.hint)
                    }
                }
            }
            if let id = state.preset, let p = WorkForm.preset(id) {
                Text(p.hint).font(.caption).foregroundStyle(.tertiary)
            }
        }
        .padding(.horizontal, Spacing.xs)
        .sensoryFeedback(.selection, trigger: state.preset)
    }
}

// MARK: - The sentence

/// The live description; missing pieces are tappable and scroll to their section.
private struct SentenceBanner: View {
    @Bindable var state: WorkFormState
    let onJump: (WorkForm.SentenceField) -> Void

    var body: some View {
        let parts = state.sentence
        let ready = state.gaps.isEmpty
        HStack(alignment: .top, spacing: Spacing.s) {
            Image(systemName: "sparkles").font(.footnote).foregroundStyle(ready ? AnyShapeStyle(AppTheme.accent) : AnyShapeStyle(.secondary)).padding(.top, 2)
            Text(attributed(parts, ready: ready))
                .font(.footnote)
                .lineSpacing(3)
                .environment(\.openURL, OpenURLAction { url in
                    if url.scheme == "optio-form", let raw = url.host(), let field = WorkForm.SentenceField(rawValue: raw) {
                        onJump(field)
                        return .handled
                    }
                    return .systemAction
                })
                .accessibilityLabel(WorkForm.sentenceText(parts))
        }
        .padding(.horizontal, Spacing.l).padding(.vertical, Spacing.m)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.bar)
        .overlay(alignment: .bottom) { Divider() }
        .animation(.snappy, value: parts)
    }

    private func attributed(_ parts: [WorkForm.SentencePart], ready: Bool) -> AttributedString {
        var out = AttributedString()
        for (i, part) in parts.enumerated() {
            switch part {
            case .text(let s):
                let punct = s.hasPrefix(",") || s.hasPrefix(".")
                var a = AttributedString((i > 0 && !punct ? " " : "") + s)
                a.foregroundColor = ready ? AppTheme.accent : Color.primary
                out += a
            case .missing(let s, let field):
                if i > 0 { out += AttributedString(" ") }
                var a = AttributedString(s)
                a.foregroundColor = StatusColor.yellow
                a.underlineStyle = .patternDash
                a.font = .footnote.weight(.semibold)
                a.link = URL(string: "optio-form://\(field.rawValue)")
                out += a
            }
        }
        return out
    }
}

// MARK: - Submit bar

private struct SubmitBar: View {
    @Bindable var state: WorkFormState
    let onCreated: (WorkForm.Created) -> Void

    private var stillNeeded: String {
        let gaps = state.gaps
        var names: [String] = []
        for g in gaps where !names.contains(WorkForm.fieldLabel(g)) { names.append(WorkForm.fieldLabel(g)) }
        if names.isEmpty, state.wantsRepoUrl, state.effectiveRepoUrl.isEmpty {
            return state.isLocal ? "Still needed: a git checkout." : "Still needed: a repo."
        }
        return names.isEmpty ? "Ready." : "Still needed: \(names.joined(separator: ", "))."
    }

    private var icon: String {
        if state.draft.when != .manual { return "clock" }
        switch state.draft.then {
        case .waitsForMessages: return "cpu"
        case .waitsForMe: return "terminal"
        case .exits: return state.draft.withRepo ? "arrow.triangle.pull" : "sparkles"
        }
    }

    var body: some View {
        HStack(spacing: Spacing.m) {
            Text(stillNeeded).font(.caption).foregroundStyle(state.canSubmit ? AnyShapeStyle(.secondary) : Tone.accent.textStyle).lineLimit(3)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                Task { if let created = await state.submit() { onCreated(created) } }
            } label: {
                HStack(spacing: 6) {
                    if state.submitting { ProgressView().tint(.white) } else { Image(systemName: icon) }
                    Text(state.submitting ? "Creating…" : state.submitLabel).lineLimit(1)
                }
                .font(.subheadline.weight(.semibold))
                .padding(.horizontal, 4).padding(.vertical, 2)
            }
            .fixedSize()
            .glassProminentButton()
            .tint(AppTheme.accent)
            .disabled(!state.canSubmit)
        }
        .padding(.horizontal, Spacing.l).padding(.vertical, Spacing.m)
        .background(.bar)
        .overlay(alignment: .top) { Divider() }
    }
}
