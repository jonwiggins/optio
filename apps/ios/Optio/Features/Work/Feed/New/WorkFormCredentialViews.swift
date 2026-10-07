import SwiftUI

/// "Signed in with": Default + how the agent may sign in — the organization's
/// and your own secrets (an API key, an OAuth token, …) and the model
/// providers that serve it — plus "Add credentials…". Pod work that runs an
/// agent only; work on a machine uses the machine's own login.
struct CredentialRow: View {
    @Bindable var state: WorkFormState
    @State private var showAdd = false

    private var options: [(credential: AgentCredential, disabled: String?)] {
        state.credentials.map { c in
            if c.kind == .provider, let p = state.providers.first(where: { $0.id == c.providerId }) {
                return (c, WorkForm.providerDisabled(p, state.draft, host: state.host))
            }
            return (c, nil)
        }
    }

    var body: some View {
        let opts = options
        let picked = state.pickedCredential
        let glyph: Glyph? = picked.map { Glyph.symbol(WorkForm.credentialSymbol($0)) }
        MenuRow(label: "Signed in with", value: picked?.label ?? "Default", glyph: glyph) {
            MenuChoice(title: "Default", subtitle: defaultSubtitle, selected: picked == nil) { state.setCredential(nil) }
            ForEach(opts, id: \.credential.id) { o in
                MenuChoice(
                    title: o.credential.label,
                    subtitle: o.disabled ?? WorkForm.credentialTag(o.credential),
                    selected: o.credential.id == picked?.id,
                    glyph: .symbol(WorkForm.credentialSymbol(o.credential))
                ) { state.setCredential(o.credential) }
                .disabled(o.disabled != nil)
            }
            Divider()
            Button { showAdd = true } label: { Label("Add credentials…", systemImage: "plus") }
        }
        .accessibilityIdentifier("work-credential")
        .sheet(isPresented: $showAdd) {
            AddCredentialSheet(state: state)
        }
    }

    private var defaultSubtitle: String {
        if let d = state.defaultCredential {
            return "\(d.label) · \(d.owner == .me ? "yours" : "the organization's")"
        }
        return state.credentialsLoading ? "Loading…" : "The server's agent credentials"
    }
}

/// "Add credentials…": a method the agent signs in with, the value
/// (write-only), the owner, and a Test against the service where the server
/// can check it. Amazon Bedrock is set up in Settings → Model providers.
struct AddCredentialSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Bindable var state: WorkFormState

    @State private var methodName = ""
    @State private var value = ""
    @State private var reveal = false
    @State private var owner: ResourceOwner = .me
    @State private var checkFirst = true
    @State private var verifying = false
    @State private var verified: VerifyAgentCredentialResult?
    @State private var saving = false
    @State private var error: String?

    private var addable: [AgentCredentialMethodOption] { state.addableCredentials }
    private var method: AgentCredentialMethodOption? { addable.first { $0.secretName == methodName } }
    private var runtimeName: String { WorkForm.runtimeLabel(state.draft.runtime) }
    private var trimmed: String { value.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    if addable.isEmpty {
                        Text("Nothing to add here for \(runtimeName).").foregroundStyle(.secondary)
                    } else {
                        Picker("Method", selection: $methodName) {
                            ForEach(addable, id: \.secretName) { m in Text(m.label).tag(m.secretName) }
                        }
                        .accessibilityIdentifier("credential-method")
                    }
                    if WorkForm.providerAgent(state.draft.runtime) != nil {
                        NavigationLink { ModelProvidersView() } label: {
                            Label("Amazon Bedrock…", systemImage: "cloud")
                        }
                    }
                } header: {
                    Text("How \(runtimeName) signs in")
                } footer: {
                    if WorkForm.providerAgent(state.draft.runtime) != nil {
                        Text("Bedrock providers are set up in Settings → Model providers and then listed here.")
                    }
                }
                if let m = method {
                    Section {
                        field(for: m)
                        OwnerPicker(owner: $owner, what: "credential", canOrg: state.isAdmin)
                        if m.verifiable {
                            Toggle("Check it with the service first", isOn: $checkFirst)
                        }
                    } footer: {
                        Text(fieldFooter(m))
                    }
                    if m.verifiable {
                        Section {
                            HStack {
                                Button {
                                    test(m)
                                } label: {
                                    if verifying { ProgressView() } else { Text("Test") }
                                }
                                .disabled(verifying || trimmed.isEmpty)
                                Spacer()
                                if let v = verified {
                                    Label(v.valid ? (v.detail ?? "Works") : (v.error ?? "Rejected"), systemImage: v.valid ? "checkmark.circle" : "xmark.circle")
                                        .foregroundStyle(v.valid ? .green : .red)
                                        .font(.footnote)
                                        .lineLimit(2)
                                }
                            }
                        }
                    }
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("Add credentials")
            .navigationBarTitleDisplayMode(.inline)
            .onAppear {
                owner = state.isAdmin ? state.draft.owner : .me
                if methodName.isEmpty { methodName = addable.first?.secretName ?? "" }
            }
            .onChange(of: methodName) { _, _ in verified = nil; error = nil }
            .onChange(of: value) { _, _ in verified = nil }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button {
                        save()
                    } label: { if saving { ProgressView() } else { Text("Save") } }
                    .disabled(saving || method == nil || trimmed.isEmpty)
                    .accessibilityIdentifier("credential-save")
                }
            }
        }
    }

    @ViewBuilder
    private func field(for m: AgentCredentialMethodOption) -> some View {
        switch m.input {
        case .url:
            TextField("https://…", text: $value)
                .keyboardType(.URL).textContentType(.URL)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .accessibilityIdentifier("credential-value")
        case .project:
            TextField("Project id", text: $value)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .accessibilityIdentifier("credential-value")
        case .token, .unknown:
            HStack {
                Group {
                    if reveal {
                        TextField(m.label, text: $value)
                    } else {
                        SecureField(m.label, text: $value)
                    }
                }
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .accessibilityIdentifier("credential-value")
                Button { reveal.toggle() } label: {
                    Image(systemName: reveal ? "eye.slash" : "eye").foregroundStyle(.secondary)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel(reveal ? "Hide" : "Show")
            }
        }
    }

    private func fieldFooter(_ m: AgentCredentialMethodOption) -> String {
        var lines: [String] = []
        if let hint = m.hint, !hint.isEmpty { lines.append(hint) }
        lines.append(OwnerPicker.hint(owner: owner, what: "credential", canOrg: state.isAdmin))
        lines.append("Encrypted at rest; the value is never shown again. Replaces the \(owner == .me ? "private" : "organization's") \(m.secretName) if one exists.")
        return lines.joined(separator: " ")
    }

    private func test(_ m: AgentCredentialMethodOption) {
        Task {
            verifying = true
            do {
                verified = try await state.verifyCredential(secretName: m.secretName, value: trimmed)
            } catch {
                verified = VerifyAgentCredentialResult(valid: false, error: ErrorText.humanize(error))
            }
            verifying = false
        }
    }

    private func save() {
        guard let m = method else { return }
        Task {
            saving = true
            error = nil
            do {
                try await state.createCredential(
                    secretName: m.secretName,
                    value: trimmed,
                    owner: owner,
                    verify: m.verifiable ? checkFirst : false
                )
                value = ""
                dismiss()
            } catch {
                self.error = ErrorText.humanize(error)
            }
            saving = false
        }
    }
}
