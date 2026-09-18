import SwiftUI

/// Mirrors apps/web/src/app/tasks/new (Repo Task, run now). Scheduled blueprints
/// are created from the Scheduled section instead.
struct NewTaskSheet: View {
    var onCreated: (TaskRow) -> Void
    @Environment(APIClient.self) private var api
    @Environment(\.dismiss) private var dismiss

    @State private var repos: [RunRepoRow] = []
    @State private var templates: [RunPromptTemplateRow] = []
    @State private var repoId = ""
    @State private var title = ""
    @State private var prompt = ""
    @State private var description = ""
    @State private var branch = "main"
    @State private var agentType = "claude-code"
    @State private var priority = 100
    @State private var maxRetries = 3
    @State private var templateId = ""
    @State private var loadingRepos = true
    @State private var saving = false
    @State private var error: Error?

    private var repo: RunRepoRow? { repos.first { $0.id == repoId } }
    private var canSubmit: Bool { !saving && repo != nil && !title.trimmingCharacters(in: .whitespaces).isEmpty && !prompt.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            Form {
                Section("Where") {
                    if loadingRepos {
                        ProgressView()
                    } else if repos.isEmpty {
                        Text("No repos configured. Add one under Admin → Repos.").foregroundStyle(.secondary)
                    } else {
                        Picker("Repository", selection: $repoId) {
                            ForEach(repos) { r in Text(r.displayName).tag(r.id) }
                        }
                        .onChange(of: repoId) { _, _ in
                            if let repo { branch = repo.defaultBranch ?? "main"; agentType = repo.defaultAgentType ?? agentType }
                        }
                        TextField("Branch", text: $branch).autocorrectionDisabled().textInputAutocapitalization(.never)
                    }
                }
                Section("Who") {
                    Picker("Agent", selection: $agentType) {
                        ForEach(RunFormatting.agentTypes, id: \.0) { Text($0.1).tag($0.0) }
                    }
                }
                Section("What") {
                    TextField("Title", text: $title)
                    if !templates.isEmpty {
                        Picker("Prompt template", selection: $templateId) {
                            Text("None").tag("")
                            ForEach(templates) { t in Text(t.name).tag(t.id) }
                        }
                        .onChange(of: templateId) { _, id in
                            if let t = templates.first(where: { $0.id == id }) {
                                prompt = t.template
                                if let a = t.defaultAgentType { agentType = a }
                            }
                        }
                    }
                    TextEditor(text: $prompt).frame(minHeight: 160)
                        .overlay(alignment: .topLeading) {
                            if prompt.isEmpty { Text("Describe what the agent should do…").foregroundStyle(.tertiary).padding(.top, 8).padding(.leading, 4).allowsHitTesting(false) }
                        }
                }
                Section("Why") {
                    TextField("Why does this task exist? Who asked for it?", text: $description, axis: .vertical).lineLimit(1...4)
                }
                Section {
                    Stepper("Priority: \(priority)", value: $priority, in: 0...1000, step: 10)
                    Stepper("Max retries: \(maxRetries)", value: $maxRetries, in: 0...10)
                } footer: { Text("Lower priority number runs first. Default 100.") }
                if let error { ErrorRow(error: error) }
            }
            .navigationTitle("New Task")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { submit() } label: { if saving { ProgressView() } else { Text("Create") } }
                        .disabled(!canSubmit)
                }
            }
            .task {
                do {
                    repos = try await api.runListRepos()
                    if repoId.isEmpty, let first = repos.first {
                        repoId = first.id
                        branch = first.defaultBranch ?? "main"
                        agentType = first.defaultAgentType ?? agentType
                    }
                } catch { self.error = error }
                loadingRepos = false
                templates = (try? await api.runListPromptTemplates(kind: "task")) ?? []
            }
        }
    }

    private func submit() {
        guard let repo else { return }
        saving = true
        Task {
            do {
                let task = try await api.createTask(CreateTaskBody(
                    title: title.trimmingCharacters(in: .whitespaces),
                    prompt: prompt,
                    repoUrl: repo.repoUrl,
                    repoBranch: branch.isEmpty ? nil : branch,
                    agentType: agentType,
                    description: description.isEmpty ? nil : description,
                    priority: priority,
                    maxRetries: maxRetries
                ))
                dismiss()
                onCreated(task)
            } catch { self.error = error }
            saving = false
        }
    }
}
