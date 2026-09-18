import SwiftUI

/// Create / edit form for a persistent agent. Mirrors `apps/web/src/app/agents/new/page.tsx`;
/// edit mode PATCHes the same fields (slug is immutable).
struct AgentFormSheet: View {
    enum Mode { case create, edit(PersistentAgent) }

    let mode: Mode
    var onSaved: (PersistentAgent) -> Void

    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    static let runtimes = ["claude-code", "codex", "copilot", "gemini", "opencode", "cursor"]
    static let lifecycles = ["sticky", "always-on", "on-demand"]

    @State private var slug = ""
    @State private var name = ""
    @State private var description = ""
    @State private var agentRuntime = "claude-code"
    @State private var model = ""
    @State private var podLifecycle = "sticky"
    @State private var idlePodTimeoutMs = 300_000
    @State private var maxTurnDurationMs = 600_000
    @State private var maxTurns = 50
    @State private var consecutiveFailureLimit = 3
    @State private var systemPrompt = ""
    @State private var agentsMd = AgentFormSheet.defaultAgentsMd
    @State private var initialPrompt = ""
    @State private var enabled = true
    @State private var saving = false
    @State private var error: Error?

    private var isEdit: Bool { if case .edit = mode { return true } else { return false } }

    private var valid: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && !initialPrompt.trimmingCharacters(in: .whitespaces).isEmpty
            && (isEdit || slug.range(of: "^[a-z0-9][a-z0-9-]*$", options: .regularExpression) != nil)
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("Identity") {
                    if !isEdit {
                        TextField("Slug (a-z, 0-9, hyphens)", text: $slug)
                            .autocorrectionDisabled().textInputAutocapitalization(.never)
                            .font(.body.monospaced())
                            .onChange(of: slug) { _, v in slug = v.lowercased() }
                    }
                    TextField("Name", text: $name)
                    TextField("Description", text: $description, axis: .vertical).lineLimit(1...3)
                }
                Section("Runtime") {
                    Picker("Runtime", selection: $agentRuntime) {
                        ForEach(Self.runtimes, id: \.self) { Text($0).tag($0) }
                    }
                    TextField("Model (default for runtime)", text: $model)
                        .autocorrectionDisabled().textInputAutocapitalization(.never)
                    Picker("Pod lifecycle", selection: $podLifecycle) {
                        ForEach(Self.lifecycles, id: \.self) { Text($0).tag($0) }
                    }
                    if isEdit { Toggle("Enabled", isOn: $enabled) }
                }
                Section {
                    Stepper("Idle pod TTL: \(idlePodTimeoutMs / 1000)s", value: $idlePodTimeoutMs, in: 30_000...3_600_000, step: 30_000)
                        .disabled(podLifecycle != "sticky")
                    Stepper("Max turn duration: \(maxTurnDurationMs / 60_000) min", value: $maxTurnDurationMs, in: 60_000...7_200_000, step: 60_000)
                    Stepper("Max turns: \(maxTurns)", value: $maxTurns, in: 1...10_000)
                    Stepper("Failures before halt: \(consecutiveFailureLimit)", value: $consecutiveFailureLimit, in: 1...50)
                } header: {
                    Text("Limits")
                } footer: {
                    Text("Idle pod TTL applies to sticky mode only. Consecutive failures past the limit move the agent to FAILED.")
                }
                Section {
                    TextEditor(text: $systemPrompt).font(.caption.monospaced()).frame(minHeight: 90)
                } header: { Text("System prompt") } footer: { Text("Persona — who is this agent? Stays constant across all turns.") }
                Section {
                    TextEditor(text: $agentsMd).font(.caption.monospaced()).frame(minHeight: 140)
                } header: { Text("Operator manual (agents.md)") } footer: { Text("How to use the Optio internal API. Shown to the agent every turn.") }
                Section {
                    TextEditor(text: $initialPrompt).font(.caption.monospaced()).frame(minHeight: 90)
                } header: { Text("Initial prompt") } footer: { Text("The agent's first mission — sent only on the first turn.") }
                if let error { ErrorBanner(error: error) }
            }
            .navigationTitle(isEdit ? "Edit agent" : "New agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : (isEdit ? "Save" : "Create")) { Task { await save() } }
                        .disabled(saving || !valid)
                }
            }
            .onAppear(perform: seed)
        }
    }

    private func seed() {
        guard case .edit(let a) = mode else { return }
        slug = a.slug
        name = a.name
        description = a.description ?? ""
        agentRuntime = a.agentRuntime
        model = a.model ?? ""
        podLifecycle = a.podLifecycle.rawValue
        idlePodTimeoutMs = Int(a.idlePodTimeoutMs)
        maxTurnDurationMs = Int(a.maxTurnDurationMs)
        maxTurns = Int(a.maxTurns)
        consecutiveFailureLimit = Int(a.consecutiveFailureLimit)
        systemPrompt = a.systemPrompt ?? ""
        agentsMd = a.agentsMd ?? ""
        initialPrompt = a.initialPrompt
        enabled = a.enabled
    }

    private func save() async {
        saving = true
        defer { saving = false }
        var input = PersistentAgentInput(
            name: name.trimmingCharacters(in: .whitespaces),
            description: description.isEmpty ? nil : description,
            agentRuntime: agentRuntime,
            model: model.isEmpty ? nil : model,
            systemPrompt: systemPrompt.isEmpty ? nil : systemPrompt,
            agentsMd: agentsMd.isEmpty ? nil : agentsMd,
            initialPrompt: initialPrompt,
            podLifecycle: podLifecycle,
            idlePodTimeoutMs: idlePodTimeoutMs,
            maxTurnDurationMs: maxTurnDurationMs,
            maxTurns: maxTurns,
            consecutiveFailureLimit: consecutiveFailureLimit
        )
        do {
            let saved: PersistentAgent
            switch mode {
            case .create:
                input.slug = slug
                saved = try await api.createPersistentAgent(input)
            case .edit(let a):
                input.enabled = enabled
                saved = try await api.updatePersistentAgent(a.id, input)
            }
            onSaved(saved)
            dismiss()
        } catch {
            self.error = error
        }
    }

    static let defaultAgentsMd = """
    You are running as a Persistent Agent inside Optio. You can talk to other
    agents in this workspace through Optio's HTTP API. Use the bash + curl
    verbs below — there is no human waiting at a terminal, so design every
    call to be non-interactive.

    Environment variables (already set):
    - OPTIO_API_URL          — base URL for Optio's API
    - OPTIO_AGENT_TOKEN      — your bearer token (your own UUID)
    - OPTIO_PERSISTENT_AGENT_SLUG — your own slug
    - OPTIO_PERSISTENT_AGENT_TURN_ID — current turn id

    ## List addressable agents in your workspace

        curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
          "$OPTIO_API_URL/api/internal/persistent-agents"

    ## Send a direct message to another agent (by slug)

        curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
          -H "Content-Type: application/json" \\
          -d '{"to":"forge","body":"Please implement spec X..."}' \\
          "$OPTIO_API_URL/api/internal/persistent-agents/send"

    ## Broadcast to everyone in your workspace

        curl -s -X POST -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
          -H "Content-Type: application/json" \\
          -d '{"body":"Heads up, the build is broken."}' \\
          "$OPTIO_API_URL/api/internal/persistent-agents/broadcast"

    ## Read your own recent inbox

        curl -s -H "X-Optio-Agent-Token: $OPTIO_AGENT_TOKEN" \\
          "$OPTIO_API_URL/api/internal/persistent-agents/inbox?limit=20"

    ## Inbox messages you receive

    Messages from other agents arrive in your prompt as structured blocks:

        ---BEGIN OPTIO MESSAGE---
        {"version":1,"timestamp":"...","sender":"agent:.../forge","type":"instruction","broadcasted":false,"body":"..."}
        ---END OPTIO MESSAGE---

    Always read these carefully — they are your inputs.

    ## Halt

    When you have nothing more to do this turn, simply finish your response.
    Optio will mark the turn complete and you'll be re-woken on the next
    message, webhook, or scheduled tick.
    """
}
