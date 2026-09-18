import SwiftUI

/// Mirrors `new-terminal-dialog.tsx`: host, directory (from the host's
/// allowlist or typed), title, and what to run (shell / command / agent).
struct NewTerminalSheet: View {
    enum Kind: Hashable { case shell, command, agent }

    let hosts: [LocalHost]
    var onCreated: (LocalTerminal) -> Void

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss
    @State private var hostId = ""
    @State private var dir = ""
    @State private var customDir = false
    @State private var title = ""
    @State private var kind: Kind = .shell
    @State private var command = ""
    @State private var agent: LocalAgentKind = .claudeCode
    @State private var prompt = ""
    @State private var creating = false
    @State private var error: String?

    private var host: LocalHost? { hosts.first { $0.id == hostId } }
    private var effectiveDir: String {
        let typed = dir.trimmingCharacters(in: .whitespaces)
        return typed.isEmpty ? (host?.dirs.first?.path ?? "") : typed
    }
    private var canSubmit: Bool {
        !hostId.isEmpty && !effectiveDir.isEmpty && (kind != .command || !command.trimmingCharacters(in: .whitespaces).isEmpty)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Where") {
                    Picker("Host", selection: $hostId) {
                        ForEach(hosts, id: \.id) { h in
                            Text(h.state == .offline ? "\(h.name) (offline)" : h.name).tag(h.id)
                        }
                    }
                    .onChange(of: hostId) { _, _ in dir = ""; customDir = false }

                    if let host, !host.dirs.isEmpty, !customDir {
                        Picker("Directory", selection: Binding(get: { effectiveDir }, set: { dir = $0 })) {
                            ForEach(host.dirs, id: \.path) { d in
                                Text(d.path).font(.caption.monospaced()).tag(d.path)
                            }
                        }
                        .pickerStyle(.navigationLink)
                        Button("Type a different path…") { customDir = true; dir = "" }.font(.footnote)
                    } else {
                        TextField("/absolute/path/on/the/host", text: $dir)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        if let host, host.dirs.isEmpty {
                            Text("No dirs on this host — run `optio local add <dir>` there.")
                                .font(.caption).foregroundStyle(.secondary)
                        } else if customDir {
                            Button("Pick from the host's directories") { customDir = false; dir = "" }.font(.footnote)
                        }
                    }
                }

                Section("Run") {
                    Picker("Run", selection: $kind) {
                        Text("Shell").tag(Kind.shell)
                        Text("Command").tag(Kind.command)
                        Text("Agent").tag(Kind.agent)
                    }
                    .pickerStyle(.segmented)

                    if kind == .command {
                        TextField("e.g. pnpm test --watch", text: $command)
                            .font(.body.monospaced())
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    if kind == .agent {
                        Picker("Agent", selection: $agent) {
                            ForEach(LocalAgentKind.allCases, id: \.self) { a in
                                Text(LocalPresentation.agentLabel(a)).tag(a)
                            }
                        }
                        TextField("What should the agent do? (optional)", text: $prompt, axis: .vertical)
                            .lineLimit(3...8)
                    }
                }

                Section {
                    TextField("Title (optional), e.g. fix flaky tests", text: $title)
                }

                if let error {
                    Section { Text(error).foregroundStyle(.red).font(.footnote) }
                }
            }
            .navigationTitle("New Terminal")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { Task { await create() } } label: {
                        if creating { ProgressView() } else { Text("Spawn") }
                    }
                    .disabled(!canSubmit || creating)
                }
            }
            .onAppear {
                if hostId.isEmpty {
                    hostId = hosts.first(where: { $0.state == .online })?.id ?? hosts.first?.id ?? ""
                }
            }
        }
    }

    private func create() async {
        creating = true
        error = nil
        let spec: LocalTerminalSpec
        switch kind {
        case .shell: spec = .shell
        case .command: spec = .command(.init(command: command.trimmingCharacters(in: .whitespaces)))
        case .agent:
            let p = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
            spec = .agent(.init(agent: agent, prompt: p.isEmpty ? nil : p))
        }
        let t = title.trimmingCharacters(in: .whitespaces)
        do {
            let created = try await api.createLocalTerminal(CreateLocalTerminalBody(hostId: hostId, dir: effectiveDir, title: t.isEmpty ? nil : t, spec: spec))
            onCreated(created)
            dismiss()
        } catch {
            self.error = error.localizedDescription
        }
        creating = false
    }
}
